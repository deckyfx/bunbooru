import { embeddedMigrations } from "./migrations.embedded";

import { definePlugin, type IngestGuard, type PluginContext } from "@bunbooru/plugin-sdk";

import { refusalReason } from "./hashes";
import { buildBannedHashesRoutes, PLUGIN_ID } from "./routes";
import { findBan } from "./store";

export { buildBannedHashesRoutes, type BannedHashesPluginApp } from "./routes";

/**
 * Refuse an upload whose sha256 or md5 is banned: one indexed lookup on the
 * hashes Core already computed, before dedupe, so a banned file can't come
 * back as a copy of one still stored.
 */
export function banGuard(ctx: PluginContext): IngestGuard {
  return {
    async check({ sha256, md5 }) {
      const ban = await findBan(ctx.db, { sha256, md5 });
      return ban ? { allow: false, reason: refusalReason(ban.reason) } : { allow: true };
    },
  };
}

/**
 * Banned hashes: moderators ban a file (by hash, or from its post page), and
 * no upload of those exact bytes gets in again, from any source. A re-encoded
 * copy has different hashes, so this stops re-uploads, not look-alikes.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Banned hashes",
  version: "1.0.0",
  description: "Blocks re-uploads of banned files by sha256/md5, from every upload source.",
  capabilities: ["routes", "tables", "ingest-guards", "ui-slots"],
  tables: ["banned_hashes_entries"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_banned_hashes",
  },
  register(ctx) {
    return {
      routes: buildBannedHashesRoutes(ctx),
      ingestGuards: [banGuard(ctx)],
    };
  },
});
