import { Elysia, NotFoundError, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  isOwnerOrAdmin,
  pluginRoutePrefix,
  type PluginContext,
  type User,
} from "@bunbooru/plugin-sdk";

import { isEdited, MAX_BODY, normalizeBody } from "./body";
import type { CommentRow } from "./schema";
import { createComment, deleteComment, findComment, listForAsset, listRecent, updateComment } from "./store";

export const PLUGIN_ID = "comments";

const idParam = t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 });

/**
 * Raw comment text bound. Looser than the stored limit so surrounding
 * whitespace doesn't fail schema validation; {@link normalizeBody} enforces
 * the real limit after trimming (a 400 with a readable message).
 */
const bodyInput = t.Object({ body: t.String({ maxLength: MAX_BODY * 2 }) });

/** Page size for a post's thread and for the recent feed. */
const PAGE_LIMIT = 50;

/**
 * A comment, as the routes return it, for `viewer`. The author's id stays
 * server-side: `canEdit` tells the UI whether to offer Edit/Delete (the
 * PATCH/DELETE routes check again whatever it shows).
 */
function serializeComment(comment: CommentRow, viewer: User | null) {
  return {
    id: comment.id,
    assetId: comment.assetId,
    authorName: comment.authorName,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    edited: isEdited(comment),
    canEdit: viewer !== null && isOwnerOrAdmin(viewer, comment.authorId),
  };
}

/**
 * Split a `limit + 1` fetch into one page and the keyset cursor for the next
 * (the last id on this page), or null when nothing follows.
 */
function page(rows: CommentRow[]): { items: CommentRow[]; next: number | null } {
  const items = rows.slice(0, PAGE_LIMIT);
  return { items, next: rows.length > PAGE_LIMIT ? (items.at(-1)?.id ?? null) : null };
}

/**
 * The comments routes, under `/api/v1/plugins/comments`. Reading is public;
 * any signed-in user may comment; a comment's author or an admin may edit or
 * delete it.
 */
export function buildCommentsRoutes(ctx: PluginContext) {
  /** The caller, or 401. */
  const requireUser = async (request: Request): Promise<User> => {
    const user = await ctx.auth.currentUser(request);
    if (!user) throw new AuthenticationError();
    return user;
  };
  /** The comment `id` if `user` may change it; else 404/403. */
  const requireEditable = async (id: number, user: User): Promise<CommentRow> => {
    const comment = await findComment(ctx.db, id);
    if (!comment) throw new NotFoundError("Comment not found");
    if (!isOwnerOrAdmin(user, comment.authorId)) throw new AuthorizationError();
    return comment;
  };

  return (
    new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
      // A post's comments, oldest first. `after` is the last id of the previous page.
      .get(
        "/assets/:id",
        async ({ request, params, query }) => {
          const viewer = await ctx.auth.currentUser(request);
          const rows = await listForAsset(ctx.db, { assetId: params.id, after: query.after, limit: PAGE_LIMIT + 1 });
          const { items, next } = page(rows);
          return { items: items.map((row) => serializeComment(row, viewer)), nextAfter: next };
        },
        { params: t.Object({ id: idParam }), query: t.Object({ after: t.Optional(idParam) }) },
      )
      // Comment on a post.
      .post(
        "/assets/:id",
        async ({ request, params, body, set }) => {
          const user = await requireUser(request);
          const text = normalizeBody(body.body);
          if (!(await ctx.services.assets.getById(params.id))) throw new NotFoundError("Post not found");
          const comment = await createComment(ctx.db, {
            assetId: params.id,
            authorId: user.id,
            authorName: user.username,
            body: text,
          });
          ctx.log.info("comment_posted", { id: comment.id, assetId: params.id, by: user.username });
          set.status = 201;
          return serializeComment(comment, user);
        },
        { params: t.Object({ id: idParam }), body: bodyInput },
      )
      // Edit a comment's text (its author or an admin).
      .patch(
        "/comments/:id",
        async ({ request, params, body }) => {
          const user = await requireUser(request);
          const text = normalizeBody(body.body);
          await requireEditable(params.id, user);
          const updated = await updateComment(ctx.db, params.id, text);
          // Deleted between the check and the update.
          if (!updated) throw new NotFoundError("Comment not found");
          ctx.log.info("comment_edited", { id: params.id, by: user.username });
          return serializeComment(updated, user);
        },
        { params: t.Object({ id: idParam }), body: bodyInput },
      )
      // Delete a comment (its author or an admin).
      .delete(
        "/comments/:id",
        async ({ request, params, set }) => {
          const user = await requireUser(request);
          await requireEditable(params.id, user);
          if (!(await deleteComment(ctx.db, params.id))) throw new NotFoundError("Comment not found");
          ctx.log.info("comment_deleted", { id: params.id, by: user.username });
          set.status = 204;
          return "";
        },
        { params: t.Object({ id: idParam }) },
      )
      // The newest comments across every post. `before` is the last id of the previous page.
      .get(
        "/recent",
        async ({ request, query }) => {
          const viewer = await ctx.auth.currentUser(request);
          const rows = await listRecent(ctx.db, { before: query.before, limit: PAGE_LIMIT + 1 });
          const { items, next } = page(rows);
          return { items: items.map((row) => serializeComment(row, viewer)), nextBefore: next };
        },
        { query: t.Object({ before: t.Optional(idParam) }) },
      )
  );
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type CommentsPluginApp = ReturnType<typeof buildCommentsRoutes>;
