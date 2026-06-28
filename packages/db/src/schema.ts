/**
 * Drizzle schema for the Core domain — the only tables the engine itself owns
 * (per CLAUDE.md: Assets, Tags, Users; everything else is a plugin). Plugin
 * tables live in their own packages and are never declared here.
 *
 * Inferred `$inferSelect` / `$inferInsert` types are the canonical row shapes;
 * repositories and services consume these rather than hand-written interfaces.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Content maturity rating, mirroring the booru convention. */
export const ratingEnum = pgEnum("rating", ["safe", "questionable", "explicit"]);

/** Tag taxonomy bucket — drives colour/namespace in the UI. */
export const tagCategoryEnum = pgEnum("tag_category", [
  "general",
  "artist",
  "character",
  "copyright",
  "meta",
]);

/** Coarse authorization role; fine-grained permissions land with the auth PR. */
export const userRoleEnum = pgEnum("user_role", ["admin", "member", "guest"]);

/** A registered account. Passwords are stored only as Bun-hashed digests. */
export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An uploaded media item (the booru "post"). `md5` is unique so re-uploads are
 * detected cheaply; the binary itself lives behind a StorageProvider and is
 * referenced only by `storageKey`. `uploaderId` is nullable to allow anonymous
 * uploads and to survive account deletion (set null).
 */
export const assets = pgTable("assets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  md5: text("md5").notNull().unique(),
  rating: ratingEnum("rating").notNull().default("questionable"),
  source: text("source"),
  uploaderId: bigint("uploader_id", { mode: "number" }).references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A label. `postCount` is a denormalized counter maintained by the tag service. */
export const tags = pgTable("tags", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull().unique(),
  category: tagCategoryEnum("category").notNull().default("general"),
  postCount: integer("post_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Asset↔tag join. Composite primary key prevents duplicate links; the extra
 * index on `tagId` keeps "find assets for a tag" lookups off a full scan.
 * Both sides cascade so deleting an asset or tag cleans up its links.
 */
export const assetTags = pgTable(
  "asset_tags",
  {
    assetId: bigint("asset_id", { mode: "number" })
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    tagId: bigint("tag_id", { mode: "number" })
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.tagId] }),
    index("asset_tags_tag_idx").on(table.tagId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type AssetTag = typeof assetTags.$inferSelect;
export type NewAssetTag = typeof assetTags.$inferInsert;

/** Domain enum unions, derived from the pg enums so they can't drift. */
export type Rating = (typeof ratingEnum.enumValues)[number];
export type TagCategory = (typeof tagCategoryEnum.enumValues)[number];
export type UserRole = (typeof userRoleEnum.enumValues)[number];
