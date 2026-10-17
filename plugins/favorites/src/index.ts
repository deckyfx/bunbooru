import { embeddedMigrations } from "./migrations.embedded";

import { and, count, eq, sql } from "drizzle-orm";
import { Elysia, NotFoundError, t } from "elysia";

import {
  AuthenticationError,
  definePlugin,
  pluginRoutePrefix,
  type PluginContext,
  type SearchProvider,
} from "@bunbooru/plugin-sdk";

import { favorites } from "./schema";

/** This plugin's stable id: its route-prefix segment and migrations suffix. */
const PLUGIN_ID = "favorites";

/** A post id path param, the same bounds as Core's. */
const assetParam = t.Object({
  id: t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }),
});

/** A post's favorite state as the widget shows it. */
export interface FavoriteStatus {
  count: number;
  /** Whether the caller has favorited it; false when anonymous. */
  favorited: boolean;
}

/** How many users favorited `assetId`, and whether `userId` is one of them. */
async function statusOf(ctx: PluginContext, assetId: number, userId: number | null): Promise<FavoriteStatus> {
  const [row] = await ctx.db
    .select({
      count: count(),
      mine:
        userId === null
          ? sql<boolean>`false`
          : sql<boolean>`coalesce(bool_or(${favorites.userId} = ${userId}), false)`,
    })
    .from(favorites)
    .where(eq(favorites.assetId, assetId));
  return { count: row?.count ?? 0, favorited: Boolean(row?.mine) };
}

/** 404 unless the post exists (a favorite of nothing is meaningless). */
async function requireAsset(ctx: PluginContext, assetId: number): Promise<void> {
  if (!(await ctx.services.assets.getById(assetId))) throw new NotFoundError("Post not found");
}

/**
 * The favorites routes, under `/api/v1/plugins/favorites`. Reading a post's
 * count is public; favoriting needs a signed-in user (401 otherwise), and a user
 * can only ever change their own favorites.
 */
export function buildFavoritesRoutes(ctx: PluginContext) {
  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    .get(
      "/assets/:id",
      async ({ params, request }): Promise<FavoriteStatus> => {
        await requireAsset(ctx, params.id);
        const user = await ctx.auth.currentUser(request);
        return statusOf(ctx, params.id, user?.id ?? null);
      },
      { params: assetParam },
    )
    .put(
      "/assets/:id",
      async ({ params, request }): Promise<FavoriteStatus> => {
        const user = await ctx.auth.currentUser(request);
        if (!user) throw new AuthenticationError();
        await requireAsset(ctx, params.id);
        // Idempotent: favoriting twice is one favorite.
        await ctx.db
          .insert(favorites)
          .values({ userId: user.id, assetId: params.id })
          .onConflictDoNothing();
        return statusOf(ctx, params.id, user.id);
      },
      { params: assetParam },
    )
    .delete(
      "/assets/:id",
      async ({ params, request }): Promise<FavoriteStatus> => {
        const user = await ctx.auth.currentUser(request);
        if (!user) throw new AuthenticationError();
        await requireAsset(ctx, params.id);
        await ctx.db
          .delete(favorites)
          .where(and(eq(favorites.userId, user.id), eq(favorites.assetId, params.id)));
        return statusOf(ctx, params.id, user.id);
      },
      { params: assetParam },
    );
}

/** Server type for a typed Eden Treaty client on the web (paths incl. the prefix). */
export type FavoritesPluginApp = ReturnType<typeof buildFavoritesRoutes>;

/**
 * `fav:alice`: posts alice has favorited. It composes with every other term
 * (`fav:alice rating:safe -solo`), and the name is resolved through Core's auth
 * service, since the plugin may not read Core's users table. An unknown user
 * matches nothing.
 */
export function favSearch(ctx: PluginContext): SearchProvider {
  return {
    key: "fav",
    async compile({ op, value }, asset) {
      if (op !== "eq") return undefined;
      const user = await ctx.services.auth.findByUsername(value.toLowerCase());
      if (!user) return sql`false`;
      return sql`exists (select 1 from ${favorites} where ${favorites.assetId} = ${asset.id} and ${favorites.userId} = ${user.id})`;
    },
  };
}

/**
 * Favorites: a member can favorite posts (★ on the post page), see how many
 * people favorited each, find posts by who favorited them (`fav:<username>`),
 * and browse their own at `/favorites`.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Favorites",
  version: "1.0.0",
  description: "Favorite posts, see favorite counts, and search with fav:<username>.",
  capabilities: ["routes", "tables", "events", "search-providers", "ui-slots", "pages"],
  tables: ["favorites_posts"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_favorites",
  },
  register(ctx) {
    // A deleted post's favorites go with it (no cross-schema FK to do it).
    ctx.events.on("asset.deleted", async (event) => {
      try {
        await ctx.db.delete(favorites).where(eq(favorites.assetId, event.id));
      } catch (error) {
        ctx.log.error("favorites_cleanup_failed", {
          assetId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return {
      routes: buildFavoritesRoutes(ctx),
      searchProviders: [favSearch(ctx)],
    };
  },
});
