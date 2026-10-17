import { embeddedMigrations } from "./migrations.embedded";

import { sql } from "drizzle-orm";

import { definePlugin, type PluginContext, type SearchProvider } from "@bunbooru/plugin-sdk";

import { buildPoolsRoutes, PLUGIN_ID } from "./routes";
import { poolPosts } from "./schema";
import { findPoolIdByName, removeAssetEverywhere } from "./store";

export { buildPoolsRoutes, type PoolsPluginApp } from "./routes";

/**
 * `pool:12` or `pool:my_comic`: posts in that pool. A number is always an id
 * (pool names can't be purely numeric); anything else is a name, matched
 * case-insensitively. It composes with every other term. An unknown pool
 * matches nothing.
 */
export function poolSearch(ctx: PluginContext): SearchProvider {
  return {
    key: "pool",
    async compile({ op, value }, asset) {
      if (op !== "eq") return undefined;
      const poolId = /^\d+$/.test(value) ? Number(value) : await findPoolIdByName(ctx.db, value);
      if (poolId === null || !Number.isSafeInteger(poolId)) return sql`false`;
      return sql`exists (select 1 from ${poolPosts} where ${poolPosts.poolId} = ${poolId} and ${poolPosts.assetId} = ${asset.id})`;
    },
  };
}

/**
 * Pools: named, ordered sets of posts (comics, series, collections). Members
 * create pools and keep them in order; everyone can browse them at /pools, step
 * through one from the post page, and search with `pool:<id or name>`.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Pools",
  version: "1.0.0",
  description: "Ordered sets of posts (comics, series), with pool pages and pool:<id> search.",
  capabilities: ["routes", "tables", "events", "search-providers", "ui-slots", "pages"],
  tables: ["pools_pools", "pools_posts"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_pools",
  },
  register(ctx) {
    // A deleted post leaves every pool it was in, closing the gaps it leaves.
    ctx.events.on("asset.deleted", async (event) => {
      try {
        await removeAssetEverywhere(ctx.db, event.id);
      } catch (error) {
        ctx.log.error("pools_cleanup_failed", {
          assetId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return {
      routes: buildPoolsRoutes(ctx),
      searchProviders: [poolSearch(ctx)],
    };
  },
});
