import { bigint, index, pgTable, primaryKey, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per (user, post) favorite. `userId`/`assetId` mirror Core's
 * `users.id`/`assets.id` with no cross-schema foreign key, so the plugin stays
 * self-contained (the same rule the thumbnailer follows). The primary key makes
 * favoriting idempotent; the `asset_id` index serves "how many favorites does
 * this post have" and the `fav:` search's correlated lookup.
 */
export const favorites = pgTable(
  "favorites_posts",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    assetId: bigint("asset_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.assetId] }),
    index("favorites_posts_asset_idx").on(table.assetId),
  ],
);
