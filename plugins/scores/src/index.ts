import { embeddedMigrations } from "./migrations.embedded";

import { definePlugin, type PluginContext } from "@bunbooru/plugin-sdk";

import { buildScoresRoutes, PLUGIN_ID } from "./routes";
import { scoreSearch } from "./search";
import { scoreSort } from "./sort";
import { removeAssetScores } from "./store";

export { buildScoresRoutes, type ScoresPluginApp } from "./routes";
export { scoreSearch } from "./search";
export { scoreSort } from "./sort";
export type { ScoreStatus, Vote } from "./votes";

/**
 * Drop a deleted post's votes and totals (there's no cross-schema FK to do
 * it). Never throws: a listener's failure must not reach the deletion.
 */
export function onAssetDeleted(ctx: PluginContext) {
  return async ({ id }: { id: number }): Promise<void> => {
    try {
      await removeAssetScores(ctx.db, id);
    } catch (error) {
      ctx.log.error("scores_cleanup_failed", {
        assetId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Scores: signed-in users vote a post up or down (▲ score ▼ on the post page),
 * everyone sees its net score, `score:>10` searches by it and `order:score`
 * sorts by it.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Scores",
  version: "1.0.0",
  description: "Up/down votes on posts, a net score on each, score:<n> search and order:score.",
  capabilities: ["routes", "tables", "events", "search-providers", "sort-providers", "ui-slots"],
  tables: ["scores_votes", "scores_totals"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_scores",
  },
  register(ctx) {
    ctx.events.on("asset.deleted", onAssetDeleted(ctx));
    return {
      routes: buildScoresRoutes(ctx),
      searchProviders: [scoreSearch()],
      sortProviders: [scoreSort()],
    };
  },
});
