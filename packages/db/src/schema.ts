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
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// `bigint`/`bigserial` columns use `mode: "number"`: they need 64-bit *storage*
// (file sizes exceed int4's ~2.1 GB; PK headroom past 2.1B rows), but their
// values stay far below 2^53 (~9×10^15) at booru scale (~10^7 assets, ≤TB
// files), where JS `number` is exact. Revisit only if a column could exceed
// 2^53 — then store as bigint and serialize to string in the API (JSON has no
// 64-bit int type), never JS BigInt (it isn't JSON-serializable).

/**
 * Content maturity rating. `unrated` is the default: a freshly uploaded post is
 * unrated until someone classifies it. Appended last so adding it is a plain
 * `ALTER TYPE ... ADD VALUE` (no enum reorder).
 */
export const ratingEnum = pgEnum("rating", ["safe", "questionable", "explicit", "unrated"]);

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
 * An uploaded media item (the booru "post"). `sha256` is the unique content key
 * — collision-resistant, so it doubles as dedupe and integrity check; `md5` is
 * kept (non-unique) for booru-ecosystem compatibility (Danbooru exposes
 * `post.md5` and derives file paths from it), but MD5 collisions make it unsafe
 * as the identity key. The binary lives behind a StorageProvider, referenced
 * only by `storageKey`. `uploaderId` is nullable to allow anonymous uploads and
 * to survive account deletion (set null). CHECK constraints reject impossible
 * negative dimensions/size at the source-of-truth layer, not just in callers.
 */
export const assets = pgTable(
  "assets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull().unique(),
    md5: text("md5").notNull(),
    rating: ratingEnum("rating").notNull().default("unrated"),
    source: text("source"),
    uploaderId: bigint("uploader_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("assets_width_nonneg", sql`${table.width} >= 0`),
    check("assets_height_nonneg", sql`${table.height} >= 0`),
    check("assets_size_bytes_nonneg", sql`${table.sizeBytes} >= 0`),
    // Digests must be canonical lowercase hex of the right length, so a malformed
    // or mixed-case value can never alias or break dedupe lookups.
    check("assets_sha256_hex", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("assets_md5_hex", sql`${table.md5} ~ '^[0-9a-f]{32}$'`),
  ],
);

/** A label. `postCount` is a denormalized counter maintained by the tag service. */
export const tags = pgTable(
  "tags",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull().unique(),
    category: tagCategoryEnum("category").notNull().default("general"),
    postCount: integer("post_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("tags_post_count_nonneg", sql`${table.postCount} >= 0`)],
);

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
