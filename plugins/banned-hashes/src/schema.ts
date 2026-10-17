import { sql } from "drizzle-orm";
import { bigint, bigserial, check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One banned file, by its sha256 and/or md5 (booru ban lists are often
 * md5-keyed, so either alone is enough). The row outlives any stored copy: the
 * ban is what stops the file coming back. `bannedById` mirrors Core's
 * `users.id` with no cross-schema foreign key; `bannedByName` is copied since
 * the plugin can't read Core's users table.
 */
export const bannedHashes = pgTable(
  "banned_hashes_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sha256: text("sha256"),
    md5: text("md5"),
    reason: text("reason").notNull().default(""),
    bannedById: bigint("banned_by_id", { mode: "number" }),
    bannedByName: text("banned_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("banned_hashes_entries_sha256_idx").on(table.sha256),
    uniqueIndex("banned_hashes_entries_md5_idx").on(table.md5),
    check("banned_hashes_entries_has_hash", sql`${table.sha256} is not null or ${table.md5} is not null`),
    check("banned_hashes_entries_sha256_hex", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("banned_hashes_entries_md5_hex", sql`${table.md5} ~ '^[0-9a-f]{32}$'`),
  ],
);

export type BanRow = typeof bannedHashes.$inferSelect;
