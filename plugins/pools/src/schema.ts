import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * A pool: a named, ordered set of posts (a comic, a series, a collection).
 * `creatorId` mirrors Core's `users.id` with no cross-schema foreign key (the
 * plugin stays self-contained), and `creatorName` is copied at creation since
 * the plugin may not read Core's users table and usernames never change.
 * Names are unique case-insensitively.
 */
export const pools = pgTable(
  "pools_pools",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    creatorId: bigint("creator_id", { mode: "number" }),
    creatorName: text("creator_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pools_pools_name_lower_idx").on(sql`lower(${table.name})`)],
);

/**
 * A post's place in a pool. `position` runs 1..n with no gaps; every edit to a
 * pool's posts runs in one transaction holding the pool row's lock, so edits
 * never interleave. A post appears in a pool at most once (the primary key),
 * and deleting a pool removes its rows (a foreign key inside the plugin's own
 * tables).
 */
export const poolPosts = pgTable(
  "pools_posts",
  {
    poolId: bigint("pool_id", { mode: "number" })
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    assetId: bigint("asset_id", { mode: "number" }).notNull(),
    position: integer("position").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.poolId, table.assetId] }),
    index("pools_posts_order_idx").on(table.poolId, table.position),
    index("pools_posts_asset_idx").on(table.assetId),
  ],
);
