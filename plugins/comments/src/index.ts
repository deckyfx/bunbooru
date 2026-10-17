import { embeddedMigrations } from "./migrations.embedded";

import { definePlugin, type PluginContext } from "@bunbooru/plugin-sdk";

import { buildCommentsRoutes, PLUGIN_ID } from "./routes";
import { deleteForAsset } from "./store";

export { buildCommentsRoutes, type CommentsPluginApp } from "./routes";

/**
 * Drop a deleted post's comments. Never throws: a listener's failure must not
 * reach the deletion that fired it.
 */
export function onAssetDeleted(ctx: PluginContext) {
  return async ({ id }: { id: number }): Promise<void> => {
    try {
      const deleted = await deleteForAsset(ctx.db, id);
      if (deleted > 0) ctx.log.info("comments_deleted_with_post", { assetId: id, deleted });
    } catch (error) {
      ctx.log.error("comments_cleanup_failed", {
        assetId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Comments: flat, booru-style comments under a post, plus a site-wide feed of
 * the newest. Signed-in users comment; authors and admins edit or delete.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Comments",
  version: "1.0.0",
  description: "Comments on posts, and a page of the newest comments site-wide.",
  capabilities: ["routes", "tables", "events", "ui-slots", "pages"],
  tables: ["comments_comments"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_comments",
  },
  register(ctx) {
    ctx.events.on("asset.deleted", onAssetDeleted(ctx));
    return { routes: buildCommentsRoutes(ctx) };
  },
});
