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

import { normalizeDescription, normalizePoolName } from "./names";
import {
  appendPost,
  createPool,
  deletePool,
  findPool,
  listPools,
  MAX_POOL_SIZE,
  poolAssetIds,
  poolsByCreator,
  poolsForAsset,
  removePost,
  replacePosts,
  updatePool,
  type PoolRow,
} from "./store";

export const PLUGIN_ID = "pools";

const idParam = t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 });

/** Page size for the pool list. */
const LIST_LIMIT = 30;

/** A pool's header, as every response carries it. */
function serializePool(pool: PoolRow) {
  return {
    id: pool.id,
    name: pool.name,
    description: pool.description,
    creatorName: pool.creatorName,
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  };
}

/** List cursor: the last row's `updatedAt` and id, URL-safe. */
function encodeCursor(updatedAt: Date, id: number): string {
  return `${updatedAt.getTime()}_${id}`;
}
function decodeCursor(cursor: string): { updatedAt: Date; id: number } {
  const match = /^(\d{1,16})_(\d{1,16})$/.exec(cursor);
  if (!match) throw new ValidationError("Invalid page cursor");
  // The shape check isn't enough: 16 digits can exceed a Date's range (an
  // Invalid Date throws in toISOString, a 500) or a safe integer.
  const updatedAt = new Date(Number(match[1]));
  const id = Number(match[2]);
  if (Number.isNaN(updatedAt.getTime()) || !Number.isSafeInteger(id)) {
    throw new ValidationError("Invalid page cursor");
  }
  return { updatedAt, id };
}

/**
 * The pools routes, under `/api/v1/plugins/pools`. Reading is public. Creating
 * a pool needs a signed-in user; changing one needs its creator or an admin
 * (Core's owner-or-admin rule), checked on the server whatever the UI shows.
 */
export function buildPoolsRoutes(ctx: PluginContext) {
  /** The caller, or 401. */
  const requireUser = async (request: Request): Promise<User> => {
    const user = await ctx.auth.currentUser(request);
    if (!user) throw new AuthenticationError();
    return user;
  };
  /** The pool, or 404. */
  const requirePool = async (id: number): Promise<PoolRow> => {
    const pool = await findPool(ctx.db, id);
    if (!pool) throw new NotFoundError("Pool not found");
    return pool;
  };
  /** The pool, if the caller may edit it: 401 anonymous, 403 not theirs, 404 missing. */
  const requireEditable = async (request: Request, id: number): Promise<PoolRow> => {
    const user = await requireUser(request);
    const pool = await requirePool(id);
    if (!isOwnerOrAdmin(user, pool.creatorId)) throw new AuthorizationError();
    return pool;
  };
  /** 404 unless the post exists. */
  const requireAsset = async (assetId: number): Promise<void> => {
    if (!(await ctx.services.assets.getById(assetId))) throw new NotFoundError("Post not found");
  };

  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    .get(
      "/pools",
      async ({ query }) => {
        const pools = await listPools(ctx.db, {
          query: query.q,
          limit: LIST_LIMIT + 1,
          before: query.cursor ? decodeCursor(query.cursor) : undefined,
        });
        const page = pools.slice(0, LIST_LIMIT);
        const last = page.at(-1);
        return {
          pools: page.map((pool) => ({ ...pool, updatedAt: pool.updatedAt.toISOString() })),
          nextCursor: pools.length > LIST_LIMIT && last ? encodeCursor(last.updatedAt, last.id) : null,
        };
      },
      {
        query: t.Object({
          q: t.Optional(t.String({ maxLength: 100 })),
          cursor: t.Optional(t.String({ maxLength: 40 })),
        }),
      },
    )
    .post(
      "/pools",
      async ({ body, request, set }) => {
        const user = await requireUser(request);
        const pool = await createPool(ctx.db, {
          name: normalizePoolName(body.name),
          description: normalizeDescription(body.description ?? ""),
          creatorId: user.id,
          creatorName: user.username,
        });
        set.status = 201;
        return serializePool(pool);
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 200 }),
          description: t.Optional(t.String({ maxLength: 4000 })),
        }),
      },
    )
    // The caller's own pools, for the post page's "Add to pool".
    .get("/mine", async ({ request }) => {
      const user = await requireUser(request);
      return poolsByCreator(ctx.db, user.id);
    })
    .get(
      "/pools/:id",
      async ({ params, request }) => {
        const pool = await requirePool(params.id);
        const ids = await poolAssetIds(ctx.db, pool.id);
        const assets = await ctx.services.assets.getMany(ids);
        const user = await ctx.auth.currentUser(request);
        return {
          ...serializePool(pool),
          posts: assets.map((asset) => ({ id: asset.id, width: asset.width, height: asset.height })),
          canEdit: user !== null && isOwnerOrAdmin(user, pool.creatorId),
        };
      },
      { params: t.Object({ id: idParam }) },
    )
    .patch(
      "/pools/:id",
      async ({ params, body, request }) => {
        await requireEditable(request, params.id);
        const updated = await updatePool(ctx.db, params.id, {
          ...(body.name !== undefined ? { name: normalizePoolName(body.name) } : {}),
          ...(body.description !== undefined ? { description: normalizeDescription(body.description) } : {}),
        });
        if (!updated) throw new NotFoundError("Pool not found");
        return serializePool(updated);
      },
      {
        params: t.Object({ id: idParam }),
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          description: t.Optional(t.String({ maxLength: 4000 })),
        }),
      },
    )
    .delete(
      "/pools/:id",
      async ({ params, request, set }) => {
        await requireEditable(request, params.id);
        await deletePool(ctx.db, params.id);
        set.status = 204;
        return "";
      },
      { params: t.Object({ id: idParam }) },
    )
    // Set the order: the full list of post ids, first to last.
    .put(
      "/pools/:id/posts",
      async ({ params, body, request }) => {
        await requireEditable(request, params.id);
        const found = await ctx.services.assets.getMany(body.assetIds);
        if (found.length !== new Set(body.assetIds).size) throw new ValidationError("Some of those posts don't exist");
        await replacePosts(ctx.db, params.id, body.assetIds);
        return { assetIds: await poolAssetIds(ctx.db, params.id) };
      },
      {
        params: t.Object({ id: idParam }),
        body: t.Object({ assetIds: t.Array(idParam, { maxItems: MAX_POOL_SIZE }) }),
      },
    )
    .post(
      "/pools/:id/posts",
      async ({ params, body, request }) => {
        await requireEditable(request, params.id);
        await requireAsset(body.assetId);
        await appendPost(ctx.db, params.id, body.assetId);
        return { assetIds: await poolAssetIds(ctx.db, params.id) };
      },
      { params: t.Object({ id: idParam }), body: t.Object({ assetId: idParam }) },
    )
    .delete(
      "/pools/:id/posts/:assetId",
      async ({ params, request }) => {
        await requireEditable(request, params.id);
        await removePost(ctx.db, params.id, params.assetId);
        return { assetIds: await poolAssetIds(ctx.db, params.id) };
      },
      { params: t.Object({ id: idParam, assetId: idParam }) },
    )
    // The pools a post is in, with previous/next there (public).
    .get(
      "/assets/:id",
      async ({ params }) => {
        await requireAsset(params.id);
        return poolsForAsset(ctx.db, params.id);
      },
      { params: t.Object({ id: idParam }) },
    );
}

/** Server type for a typed Eden Treaty client on the web (paths incl. the prefix). */
export type PoolsPluginApp = ReturnType<typeof buildPoolsRoutes>;
