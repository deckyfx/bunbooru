import { embeddedMigrations } from "./migrations.embedded";

import { definePlugin } from "@bunbooru/plugin-sdk";

import { buildWikiRoutes, PLUGIN_ID } from "./routes";

export { buildWikiRoutes, type WikiPluginApp } from "./routes";

/**
 * Wiki: one page per tag (titled with the tag's name) explaining what it
 * means, each with a full edit history. Signed-in users edit; admins revert
 * and delete. Pages aren't per-post, so there's no `asset.deleted` listener.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Wiki",
  version: "1.0.0",
  description: "Wiki pages explaining tags, with edit history and post-search excerpts.",
  capabilities: ["routes", "tables", "ui-slots", "pages"],
  tables: ["wiki_pages", "wiki_page_versions"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_wiki",
  },
  register(ctx) {
    return { routes: buildWikiRoutes(ctx) };
  },
});
