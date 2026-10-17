import { Elysia, NotFoundError, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  pluginRoutePrefix,
  ValidationError,
  type PluginContext,
  type User,
} from "@bunbooru/plugin-sdk";

import { normalizeHashes, type BanHashes } from "./hashes";
import type { BanRow } from "./schema";
import { createBan, deleteBan, findBan, listBans } from "./store";

export const PLUGIN_ID = "banned-hashes";

const idParam = t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 });

/** Page size for the ban list. */
const LIST_LIMIT = 50;

/** A ban, as the routes return it. */
function serializeBan(ban: BanRow) {
  return {
    id: ban.id,
    sha256: ban.sha256,
    md5: ban.md5,
    reason: ban.reason,
    bannedByName: ban.bannedByName,
    createdAt: ban.createdAt.toISOString(),
  };
}

/**
 * The ban-list routes, under `/api/v1/plugins/banned-hashes`. Moderators only:
 * the list is moderation state. Banning a post bans its file (both hashes);
 * the post itself stays, since a ban only stops the file being uploaded again.
 */
export function buildBannedHashesRoutes(ctx: PluginContext) {
  /** The caller, if they may moderate; else 401/403. */
  const requireModerator = async (request: Request): Promise<User> => {
    const user = await ctx.auth.currentUser(request);
    if (!user) throw new AuthenticationError();
    if (!canModerate(user)) throw new AuthorizationError();
    return user;
  };

  /** A post's hashes, or 404. */
  const assetHashes = async (assetId: number): Promise<BanHashes> => {
    const asset = await ctx.services.assets.getById(assetId);
    if (!asset) throw new NotFoundError("Post not found");
    return { sha256: asset.sha256, md5: asset.md5 };
  };

  return (
    new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
      // Newest bans first. `before` is the last id of the previous page.
      .get(
        "/bans",
        async ({ request, query }) => {
          await requireModerator(request);
          const rows = await listBans(ctx.db, { before: query.before, limit: LIST_LIMIT + 1 });
          const items = rows.slice(0, LIST_LIMIT);
          return {
            items: items.map(serializeBan),
            nextBefore: rows.length > LIST_LIMIT ? (items.at(-1)?.id ?? null) : null,
          };
        },
        { query: t.Object({ before: t.Optional(idParam) }) },
      )
      // Ban a file: by its hashes, or by a post (both of that post's hashes).
      .post(
        "/bans",
        async ({ request, body, set }) => {
          const user = await requireModerator(request);
          const hasHash = Boolean(body.sha256?.trim() || body.md5?.trim());
          if (body.assetId !== undefined && hasHash) throw new ValidationError("Give hashes or a post, not both");
          const hashes = body.assetId !== undefined ? await assetHashes(body.assetId) : normalizeHashes(body);
          const ban = await createBan(ctx.db, hashes, {
            reason: body.reason?.trim() ?? "",
            bannedById: user.id,
            bannedByName: user.username,
          });
          ctx.log.info("hash_banned", { id: ban.id, by: user.username, assetId: body.assetId ?? null });
          set.status = 201;
          return serializeBan(ban);
        },
        {
          body: t.Object({
            sha256: t.Optional(t.String({ maxLength: 64 })),
            md5: t.Optional(t.String({ maxLength: 32 })),
            assetId: t.Optional(idParam),
            reason: t.Optional(t.String({ maxLength: 500 })),
          }),
        },
      )
      // Lift a ban.
      .delete(
        "/bans/:id",
        async ({ request, params, set }) => {
          const user = await requireModerator(request);
          if (!(await deleteBan(ctx.db, params.id))) throw new NotFoundError("Ban not found");
          ctx.log.info("hash_unbanned", { id: params.id, by: user.username });
          set.status = 204;
          return "";
        },
        { params: t.Object({ id: idParam }) },
      )
      // Whether a post's file is banned (the post page's moderator widget).
      .get(
        "/assets/:id",
        async ({ request, params }) => {
          await requireModerator(request);
          const ban = await findBan(ctx.db, await assetHashes(params.id));
          return { ban: ban ? serializeBan(ban) : null };
        },
        { params: t.Object({ id: idParam }) },
      )
  );
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type BannedHashesPluginApp = ReturnType<typeof buildBannedHashesRoutes>;
