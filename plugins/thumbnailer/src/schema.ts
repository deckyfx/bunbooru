import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per asset the thumbnailer has ATTEMPTED (keyed by `assetId`, mirroring
 * a Core `assets.id` with no cross-schema FK so the plugin stays self-contained).
 *
 * - Success → `storageKey`/`width`/`height` set, `failedAt` null.
 * - Failure (undecodable bytes / missing blob) → `storageKey` null, `failedAt` set.
 *
 * Recording failures (not just successes) is what makes the backfill terminate: a
 * permanently-failing asset gets a row and is excluded from "missing", instead of
 * being re-decoded on every backfill call forever.
 */
export const thumbnails = pgTable("thumbnails", {
  assetId: integer("asset_id").primaryKey(),
  storageKey: text("storage_key"),
  width: integer("width"),
  height: integer("height"),
  /** Set when generation failed; null on success. Distinguishes the two states. */
  failedAt: timestamp("failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
