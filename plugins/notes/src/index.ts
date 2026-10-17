import { embeddedMigrations } from "./migrations.embedded";

import { definePlugin, type PluginContext } from "@bunbooru/plugin-sdk";

import { buildNotesRoutes, PLUGIN_ID } from "./routes";
import { deleteForAsset } from "./store";

export { buildNotesRoutes, type NotesPluginApp } from "./routes";

/**
 * Drop a deleted post's notes. Never throws: a listener's failure must not
 * reach the deletion that fired it.
 */
export function onAssetDeleted(ctx: PluginContext) {
  return async ({ id }: { id: number }): Promise<void> => {
    try {
      const deleted = await deleteForAsset(ctx.db, id);
      if (deleted > 0) ctx.log.info("notes_deleted_with_post", { assetId: id, deleted });
    } catch (error) {
      ctx.log.error("notes_cleanup_failed", {
        assetId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Notes: boxes drawn over a post's image with text (typically translations),
 * as on Danbooru and Shimmie. Anyone reads them; signed-in users add them;
 * authors and admins edit or delete.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Notes",
  version: "1.0.0",
  description: "Boxes over a post's image with text, such as translations.",
  capabilities: ["routes", "tables", "events", "ui-slots"],
  tables: ["notes_notes"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_notes",
  },
  register(ctx) {
    ctx.events.on("asset.deleted", onAssetDeleted(ctx));
    return { routes: buildNotesRoutes(ctx) };
  },
});
