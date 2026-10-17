import { embeddedMigrations } from "./migrations.embedded";

import { definePlugin, type PluginContext } from "@bunbooru/plugin-sdk";

import { POST_DELETED_RESOLUTION } from "./reasons";
import { buildReportsRoutes, PLUGIN_ID } from "./routes";
import { resolveOpenForAsset } from "./store";

export { buildReportsRoutes, type ReportsPluginApp } from "./routes";

/**
 * Close a deleted post's open reports as resolved ("Post deleted", by no one
 * in particular: whoever or whatever deleted it, the reports are answered).
 * Never throws: a listener's failure must not reach the deletion that fired it.
 */
export function onAssetDeleted(ctx: PluginContext) {
  return async ({ id }: { id: number }): Promise<void> => {
    try {
      const resolved = await resolveOpenForAsset(ctx.db, id, POST_DELETED_RESOLUTION);
      if (resolved > 0) ctx.log.info("reports_resolved_by_deletion", { assetId: id, resolved });
    } catch (error) {
      ctx.log.error("reports_resolve_failed", {
        assetId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Reports: signed-in users report a post with a reason, and moderators work
 * the queue: dismiss a report, or delete the post (which resolves every open
 * report on it).
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Reports",
  version: "1.0.0",
  description: "Users report posts; moderators dismiss reports or delete the post from a queue.",
  capabilities: ["routes", "tables", "events", "ui-slots"],
  tables: ["reports_reports"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_reports",
  },
  register(ctx) {
    ctx.events.on("asset.deleted", onAssetDeleted(ctx));
    return { routes: buildReportsRoutes(ctx) };
  },
});
