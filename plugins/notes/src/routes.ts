import { Elysia, NotFoundError, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  isOwnerOrAdmin,
  pluginRoutePrefix,
  ValidationError,
  type PluginContext,
  type User,
} from "@bunbooru/plugin-sdk";

import { MAX_BODY, normalizeBody } from "./body";
import { normalizeBox, type NoteBox } from "./geometry";
import type { NoteRow } from "./schema";
import { createNote, deleteNote, findNote, listForAsset, updateNote } from "./store";

export const PLUGIN_ID = "notes";

const idParam = t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 });

/**
 * Raw text bound. Looser than the stored limit so surrounding whitespace
 * doesn't fail schema validation; {@link normalizeBody} enforces the real
 * limit after trimming (a 400 with a readable message).
 */
const bodyField = t.String({ maxLength: MAX_BODY * 2 });

/**
 * Box fields are plain numbers here: range, size and finiteness are checked by
 * {@link normalizeBox}, which answers with a readable 400.
 */
const createInput = t.Object({ x: t.Number(), y: t.Number(), w: t.Number(), h: t.Number(), body: bodyField });
const patchInput = t.Object({
  x: t.Optional(t.Number()),
  y: t.Optional(t.Number()),
  w: t.Optional(t.Number()),
  h: t.Optional(t.Number()),
  body: t.Optional(bodyField),
});

/**
 * A note, as the routes return it, for `viewer`. The author's id stays
 * server-side: `canEdit` tells the UI whether to offer Edit/Delete (the
 * PATCH/DELETE routes check again whatever it shows).
 */
function serializeNote(note: NoteRow, viewer: User | null) {
  return {
    id: note.id,
    x: note.x,
    y: note.y,
    w: note.w,
    h: note.h,
    body: note.body,
    authorName: note.authorName,
    updatedAt: note.updatedAt.toISOString(),
    canEdit: viewer !== null && isOwnerOrAdmin(viewer, note.authorId),
  };
}

/** Whether a PATCH body names any of the box fields. */
function touchesBox(patch: Partial<NoteBox>): boolean {
  return patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined;
}

/**
 * The notes routes, under `/api/v1/plugins/notes`. Reading is public; any
 * signed-in user may add a note; a note's author or an admin may change or
 * delete it.
 */
export function buildNotesRoutes(ctx: PluginContext) {
  /** The caller, or 401. */
  const requireUser = async (request: Request): Promise<User> => {
    const user = await ctx.auth.currentUser(request);
    if (!user) throw new AuthenticationError();
    return user;
  };

  /** The note `id` if `user` may change it; else 404/403. */
  const requireEditable = async (id: number, user: User): Promise<NoteRow> => {
    const note = await findNote(ctx.db, id);
    if (!note) throw new NotFoundError("Note not found");
    if (!isOwnerOrAdmin(user, note.authorId)) throw new AuthorizationError();
    return note;
  };

  return (
    new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
      // A post's notes, in reading order (top to bottom, then left to right).
      .get(
        "/assets/:id",
        async ({ request, params }) => {
          const viewer = await ctx.auth.currentUser(request);
          const rows = await listForAsset(ctx.db, params.id);
          return { items: rows.map((row) => serializeNote(row, viewer)) };
        },
        { params: t.Object({ id: idParam }) },
      )
      // Add a note to a post.
      .post(
        "/assets/:id",
        async ({ request, params, body, set }) => {
          const user = await requireUser(request);
          const box = normalizeBox(body);
          const text = normalizeBody(body.body);
          if (!(await ctx.services.assets.getById(params.id))) throw new NotFoundError("Post not found");
          const note = await createNote(ctx.db, {
            assetId: params.id,
            ...box,
            body: text,
            authorId: user.id,
            authorName: user.username,
          });
          // Deleted after the check above, its `asset.deleted` cleanup already
          // run: don't leave an orphan note behind.
          if (!(await ctx.services.assets.getById(params.id))) {
            await deleteNote(ctx.db, note.id);
            throw new NotFoundError("Post not found");
          }
          ctx.log.info("note_added", { id: note.id, assetId: params.id, by: user.username });
          set.status = 201;
          return serializeNote(note, user);
        },
        { params: t.Object({ id: idParam }), body: createInput },
      )
      // Move/resize a note and/or edit its text (its author or an admin).
      .patch(
        "/notes/:id",
        async ({ request, params, body }) => {
          const user = await requireUser(request);
          const { body: rawText, ...boxPatch } = body;
          if (rawText === undefined && !touchesBox(boxPatch)) throw new ValidationError("Nothing to change");
          const text = rawText === undefined ? undefined : normalizeBody(rawText);
          const current = await requireEditable(params.id, user);
          // A partial box is completed from the stored one, then validated whole.
          const box = touchesBox(boxPatch)
            ? normalizeBox({
                x: boxPatch.x ?? current.x,
                y: boxPatch.y ?? current.y,
                w: boxPatch.w ?? current.w,
                h: boxPatch.h ?? current.h,
              })
            : {};
          const updated = await updateNote(ctx.db, params.id, { ...box, ...(text === undefined ? {} : { body: text }) });
          // Deleted between the check and the update.
          if (!updated) throw new NotFoundError("Note not found");
          ctx.log.info("note_edited", { id: params.id, by: user.username });
          return serializeNote(updated, user);
        },
        { params: t.Object({ id: idParam }), body: patchInput },
      )
      // Delete a note (its author or an admin).
      .delete(
        "/notes/:id",
        async ({ request, params, set }) => {
          const user = await requireUser(request);
          await requireEditable(params.id, user);
          if (!(await deleteNote(ctx.db, params.id))) throw new NotFoundError("Note not found");
          ctx.log.info("note_deleted", { id: params.id, by: user.username });
          set.status = 204;
          return "";
        },
        { params: t.Object({ id: idParam }) },
      )
  );
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type NotesPluginApp = ReturnType<typeof buildNotesRoutes>;
