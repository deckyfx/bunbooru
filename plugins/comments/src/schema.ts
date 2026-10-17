import { bigint, bigserial, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One comment on a post. Flat, booru-style: no parent, no threading.
 * `assetId` and `authorId` mirror Core's `assets.id` / `users.id` with no
 * cross-schema foreign keys (a deleted post is handled by the `asset.deleted`
 * listener); `authorName` is copied since the plugin can't read Core's users
 * table. `updatedAt` equals `createdAt` until the comment is edited.
 */
export const comments = pgTable(
  "comments_comments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    assetId: bigint("asset_id", { mode: "number" }).notNull(),
    authorId: bigint("author_id", { mode: "number" }),
    authorName: text("author_name"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A post's thread: oldest first, keyset by id.
    index("comments_comments_asset_idx").on(table.assetId, table.id),
    // The site-wide recent feed: newest first, keyset by id.
    index("comments_comments_recent_idx").on(table.id.desc()),
  ],
);

export type CommentRow = typeof comments.$inferSelect;
