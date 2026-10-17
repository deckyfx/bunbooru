import { Elysia, NotFoundError, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  ConflictError,
  pluginRoutePrefix,
  type PluginContext,
  type User,
} from "@bunbooru/plugin-sdk";

import type { WikiPageRow } from "./schema";
import { deletePage, findPage, findVersion, listPages, listVersions, savePage, type SaveResult } from "./store";
import { parseTitle } from "./title";
import { MAX_BODY, normalizeBody, requireTitle } from "./validate";

export const PLUGIN_ID = "wiki";

/** Page size for the index and for a page's history. */
const PAGE_LIMIT = 50;

/** A title as it arrives in the path (raw, before normalization). Elysia has already URL-decoded it. */
const titleParams = t.Object({ title: t.String({ maxLength: 400 }) });

/** A version number in a path or body. */
const versionNumber = t.Integer({ minimum: 1, maximum: 2_147_483_647 });

/**
 * An edit. The body bound is looser than the stored limit so surrounding
 * whitespace doesn't fail schema validation; {@link normalizeBody} enforces the
 * real limit after trimming. `baseVersion` is the version the editor loaded (0
 * for a page that didn't exist yet).
 */
const editInput = t.Object({
  body: t.String({ maxLength: MAX_BODY * 2 }),
  baseVersion: t.Optional(t.Integer({ minimum: 0, maximum: 2_147_483_647 })),
});

/** A page, as the routes return it. */
function serializePage(page: WikiPageRow) {
  return {
    title: page.title,
    body: page.body,
    version: page.version,
    updatedByName: page.updatedByName,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

/** The normalized title for a read, or 404: an invalid title names no page. */
function lookupTitle(raw: string): string {
  const parsed = parseTitle(raw);
  if (!parsed.ok) throw new NotFoundError("Wiki page not found");
  return parsed.title;
}

/** The written page, or a 409 when someone else changed it first. */
function savedPage(result: SaveResult): WikiPageRow {
  if (result.status === "stale") {
    throw new ConflictError("This page was changed since you opened it. Reload it to see the latest version.");
  }
  return result.page;
}

/**
 * The wiki routes, under `/api/v1/plugins/wiki`. Reading is public; any
 * signed-in user may create or edit a page; only an admin may revert or delete.
 */
export function buildWikiRoutes(ctx: PluginContext) {
  /** The caller, or 401. */
  const requireUser = async (request: Request): Promise<User> => {
    const user = await ctx.auth.currentUser(request);
    if (!user) throw new AuthenticationError();
    return user;
  };
  /** The caller if an admin; else 401/403. */
  const requireAdmin = async (request: Request): Promise<User> => {
    const user = await requireUser(request);
    if (!canModerate(user)) throw new AuthorizationError();
    return user;
  };
  /** The page `raw` names, or 404. */
  const requirePage = async (raw: string): Promise<WikiPageRow> => {
    const page = await findPage(ctx.db, lookupTitle(raw));
    if (!page) throw new NotFoundError("Wiki page not found");
    return page;
  };

  return (
    new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
      // The index, alphabetical: `q` narrows to titles starting with it; `after` is the previous page's last title.
      .get(
        "/pages",
        async ({ query }) => {
          // A prefix is normalized like a title, but may be partial (or blank: everything).
          const prefix = (query.q ?? "").trim().toLowerCase().replace(/\s+/g, "_");
          const rows = await listPages(ctx.db, { prefix, after: query.after, limit: PAGE_LIMIT + 1 });
          const items = rows.slice(0, PAGE_LIMIT);
          return {
            items: items.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
            nextAfter: rows.length > PAGE_LIMIT ? (items.at(-1)?.title ?? null) : null,
          };
        },
        {
          query: t.Object({
            q: t.Optional(t.String({ maxLength: 200 })),
            after: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          }),
        },
      )
      // One page.
      .get("/pages/:title", async ({ params }) => serializePage(await requirePage(params.title)), {
        params: titleParams,
      })
      // Create or edit a page (any signed-in user). A stale `baseVersion` is a 409.
      .put(
        "/pages/:title",
        async ({ request, params, body }) => {
          const user = await requireUser(request);
          const title = requireTitle(params.title);
          const text = normalizeBody(body.body);
          const result = await savePage(ctx.db, {
            title,
            body: text,
            editorName: user.username,
            baseVersion: body.baseVersion,
          });
          const page = savedPage(result);
          if (result.status === "saved") {
            ctx.log.info("wiki_page_saved", { title, version: page.version, by: user.username });
          }
          return serializePage(page);
        },
        { params: titleParams, body: editInput },
      )
      // A page's versions, newest first, without bodies. `before` is the previous page's last version.
      .get(
        "/pages/:title/history",
        async ({ params, query }) => {
          const page = await requirePage(params.title);
          const rows = await listVersions(ctx.db, { pageId: page.id, before: query.before, limit: PAGE_LIMIT + 1 });
          const items = rows.slice(0, PAGE_LIMIT);
          return {
            items: items.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
            nextBefore: rows.length > PAGE_LIMIT ? (items.at(-1)?.version ?? null) : null,
          };
        },
        { params: titleParams, query: t.Object({ before: t.Optional(versionNumber) }) },
      )
      // One past version, with its body.
      .get(
        "/pages/:title/versions/:version",
        async ({ params }) => {
          const page = await requirePage(params.title);
          const version = await findVersion(ctx.db, page.id, params.version);
          if (!version) throw new NotFoundError("No such version");
          return {
            title: version.title,
            version: version.version,
            body: version.body,
            editorName: version.editorName,
            createdAt: version.createdAt.toISOString(),
          };
        },
        {
          params: t.Object({
            title: t.String({ maxLength: 400 }),
            version: t.Numeric({ minimum: 1, maximum: 2_147_483_647, multipleOf: 1 }),
          }),
        },
      )
      // Revert to an old version (admins): its body becomes a NEW version, so history is never rewritten.
      .post(
        "/pages/:title/revert",
        async ({ request, params, body }) => {
          const user = await requireAdmin(request);
          const page = await requirePage(params.title);
          const target = await findVersion(ctx.db, page.id, body.version);
          if (!target) throw new NotFoundError("No such version");
          // Based on the version just read: an edit landing in between is a 409, not lost.
          const reverted = savedPage(
            await savePage(ctx.db, {
              title: page.title,
              body: target.body,
              editorName: user.username,
              baseVersion: page.version,
            }),
          );
          ctx.log.info("wiki_page_reverted", { title: page.title, to: body.version, by: user.username });
          return serializePage(reverted);
        },
        { params: titleParams, body: t.Object({ version: versionNumber }) },
      )
      // Delete a page and its history (admins).
      .delete(
        "/pages/:title",
        async ({ request, params, set }) => {
          const user = await requireAdmin(request);
          const title = lookupTitle(params.title);
          if (!(await deletePage(ctx.db, title))) throw new NotFoundError("Wiki page not found");
          ctx.log.info("wiki_page_deleted", { title, by: user.username });
          set.status = 204;
          return "";
        },
        { params: titleParams },
      )
  );
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type WikiPluginApp = ReturnType<typeof buildWikiRoutes>;
