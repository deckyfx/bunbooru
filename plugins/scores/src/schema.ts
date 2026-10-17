import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, smallint, timestamp } from "drizzle-orm/pg-core";

/**
 * One user's vote on a post: +1 (up) or -1 (down); no vote is no row.
 * `assetId`/`userId` mirror Core's `assets.id`/`users.id` with no cross-schema
 * foreign keys (a deleted post is cleaned up by the `asset.deleted` listener).
 * The primary key makes a user's vote on a post unique, and serves both "the
 * caller's vote" and "this post's votes" (its leading column).
 */
export const votes = pgTable(
  "scores_votes",
  {
    assetId: bigint("asset_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    value: smallint("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.userId] }),
    check("scores_votes_value_check", sql`${table.value} in (-1, 1)`),
  ],
);

/**
 * A post's running totals, kept in step with {@link votes} in the same
 * transaction as every vote change, so reading a score (and the `score:`
 * search) never aggregates votes. A post nobody voted on has no row and
 * counts as 0/0/0. `score` = `up` - `down`.
 */
export const totals = pgTable(
  "scores_totals",
  {
    assetId: bigint("asset_id", { mode: "number" }).primaryKey(),
    score: integer("score").notNull().default(0),
    up: integer("up").notNull().default(0),
    down: integer("down").notNull().default(0),
  },
  (table) => [index("scores_totals_score_idx").on(table.score)],
);

export type TotalsRow = typeof totals.$inferSelect;
