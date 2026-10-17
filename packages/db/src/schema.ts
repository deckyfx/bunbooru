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
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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

/**
 * Purpose of a short-lived, single-use {@link authTokens} token. Generic from the
 * start so email verification is additive rather than a second table: reset uses
 * `password-reset`, verification uses `verify-email`. Appended last, so a future
 * purpose (e.g. `change-email`) is a plain `ALTER TYPE ... ADD VALUE`.
 */
export const authTokenPurposeEnum = pgEnum("auth_token_purpose", [
  "password-reset",
  "verify-email",
]);

/**
 * A registered account. Passwords are stored only as Bun-hashed digests.
 * `email` is optional (nullable) — registration needs only username + password;
 * the unique constraint still holds (Postgres allows multiple NULLs).
 *
 * Username uniqueness is enforced on the CANONICAL (lowercased) form via a
 * functional unique index, not a plain per-value constraint: the auth service
 * stores usernames lowercase, and this guarantees no write path can ever create
 * `Alice` and `alice` as two distinct accounts (case-insensitive identity).
 */
export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    username: text("username").notNull(),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("member"),
    // When the account's email was proven controlled (via a `verify-email` token).
    // Nullable: an unverified (or email-less) account has NULL here. The
    // `require_verified_email_for_reset` setting decides whether a NULL blocks
    // self-serve password reset.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_username_lower_idx").on(sql`lower(${table.username})`),
    // Case-insensitive uniqueness matching findByEmail's lower(email) lookup, so
    // mixed-case variants of one address can't coexist (which would make the
    // reset lookup ambiguous). NULLs stay distinct — email is optional. Mirrors
    // the username index above.
    uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
  ],
);

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
    // Denormalized view counter — incremented once per visitor-session by the
    // stats service (debounced via `post_views`), so the gallery/detail pages
    // read it without aggregating.
    viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
    // Denormalized number of tags on the post, maintained by an asset_tags
    // trigger (like tags.post_count), so `tagcount:` filters and `order:tagcount`
    // sorts read a column instead of counting the join per row.
    tagCount: integer("tag_count").notNull().default(0),
    uploaderId: bigint("uploader_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Keyset pagination: each sort order walks (column, id), so each gets a
    // composite index. `order:views` deliberately has none: view_count changes on
    // every counted view, and an index on it would turn those cheap in-place
    // (HOT) updates into index writes. It sorts the matching rows instead.
    index("assets_created_at_id_idx").on(table.createdAt, table.id),
    index("assets_size_bytes_id_idx").on(table.sizeBytes, table.id),
    index("assets_tag_count_id_idx").on(table.tagCount, table.id),
    // Exact-match search filters: `md5:` and `user:`.
    index("assets_md5_idx").on(table.md5),
    index("assets_uploader_id_idx").on(table.uploaderId),
    check("assets_tag_count_nonneg", sql`${table.tagCount} >= 0`),
    check("assets_width_nonneg", sql`${table.width} >= 0`),
    check("assets_height_nonneg", sql`${table.height} >= 0`),
    check("assets_size_bytes_nonneg", sql`${table.sizeBytes} >= 0`),
    check("assets_view_count_nonneg", sql`${table.viewCount} >= 0`),
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

/**
 * Tag aliases: `antecedentName` (e.g. `kitty`) means the same as the consequent
 * tag (`cat`). Creating one migrates every post from the antecedent to the
 * consequent and deletes the antecedent tag, so from then on the antecedent
 * exists only here: as a NAME (no tag row to point at) that tagging and search
 * both rewrite to the consequent. No chains: a consequent is never itself an
 * antecedent (enforced by the alias service).
 */
export const tagAliases = pgTable(
  "tag_aliases",
  {
    antecedentName: text("antecedent_name").primaryKey(),
    consequentId: bigint("consequent_id", { mode: "number" })
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    creatorId: bigint("creator_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tag_aliases_consequent_idx").on(table.consequentId)],
);

/**
 * Tag implications: a post tagged with the antecedent (`cat`) is also tagged with
 * the consequent (`animal`), transitively. Implied tags are MATERIALIZED onto
 * posts (at tag time, and once for existing posts when the implication is
 * created), so search stays a plain tag lookup. Removing an implication leaves
 * tags already applied in place. The graph is kept acyclic by the implication
 * service.
 */
export const tagImplications = pgTable(
  "tag_implications",
  {
    antecedentId: bigint("antecedent_id", { mode: "number" })
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    consequentId: bigint("consequent_id", { mode: "number" })
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    creatorId: bigint("creator_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.antecedentId, table.consequentId] }),
    // The recursive closure walks antecedent → consequent; this serves the
    // reverse lookups ("what implies X?").
    index("tag_implications_consequent_idx").on(table.consequentId),
    check("tag_implications_not_self", sql`${table.antecedentId} <> ${table.consequentId}`),
  ],
);

/**
 * Tag edit history: one row per DIRECT change to a post's tags (upload, edit,
 * revert), with the full resulting set (`tags`, which a revert restores) and the
 * diff (`added` / `removed`, for display). Stored as names, not ids, so history
 * stays readable after a tag is aliased away. Bulk rewrites by aliases and
 * implications are deliberately not recorded per post: the alias/implication row
 * itself records who made that change and when.
 */
export const assetTagVersions = pgTable(
  "asset_tag_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    assetId: bigint("asset_id", { mode: "number" })
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** Who made the edit; null for system/plugin edits or a deleted account. */
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    tags: text("tags").array().notNull(),
    added: text("added").array().notNull(),
    removed: text("removed").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("asset_tag_versions_asset_idx").on(table.assetId, table.id)],
);

/**
 * View-dedup ledger: one row per (visitor, asset). The stats service upserts
 * here and only bumps `assets.view_count` when a row is newly inserted or its
 * `countedAt` is older than the session window — so refreshes within a session
 * don't inflate the count. `visitorId` is an opaque first-party cookie id (never
 * a raw IP). Cascades when the asset is deleted.
 */
export const postViews = pgTable(
  "post_views",
  {
    visitorId: text("visitor_id").notNull(),
    assetId: bigint("asset_id", { mode: "number" })
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    countedAt: timestamp("counted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.visitorId, table.assetId] }),
    index("post_views_asset_idx").on(table.assetId),
  ],
);

/**
 * Daily unique-visitor ledger: one row per (day, visitor). Recording a visit is
 * an insert-on-conflict-do-nothing, so the day's unique count is `count(*)` for
 * that day. `visitorId` is the same opaque cookie id; no IPs are stored.
 */
export const dailyVisitors = pgTable(
  "daily_visitors",
  {
    day: date("day").notNull(),
    visitorId: text("visitor_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.visitorId] })],
);

/**
 * An in-progress resumable upload. Chunks are staged to a temp file
 * (`stagingKey`) and `uploadedSize` tracks committed bytes; on completion the
 * bytes are finalized into an `asset` and the row is deleted. `token` is the
 * public, non-enumerable handle used in the `/uploads/:token` URLs.
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    token: text("token").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    uploadedSize: bigint("uploaded_size", { mode: "number" }).notNull().default(0),
    stagingKey: text("staging_key").notNull().unique(),
    uploaderId: bigint("uploader_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("upload_sessions_declared_size_nonneg", sql`${table.declaredSize} >= 0`),
    check(
      "upload_sessions_uploaded_size_range",
      sql`${table.uploadedSize} >= 0 and ${table.uploadedSize} <= ${table.declaredSize}`,
    ),
  ],
);

/**
 * A login session. The opaque token lives only in the client (httpOnly cookie or
 * an `Authorization: Bearer` header); the DB stores just its sha256 hash, so a
 * DB leak can't be replayed as a live session. Cascades when the user is deleted;
 * expired rows read as logged-out and are reclaimed by a periodic sweep.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * A tiny typed key-value store for admin-editable RUNTIME settings (e.g. upload
 * caps). The env value is the bootstrap default; a row here overrides it at
 * runtime. Values are stored as text and parsed per key by the settings service.
 * `updatedBy` records which admin last changed it (null if the user is gone).
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: bigint("updated_by", { mode: "number" }).references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Runtime activation state for first-party plugins (extensions). `id` is the
 * plugin id from the API's plugin registry. A row's `active` flag is the source
 * of truth for whether a plugin is mounted; the env `ENABLED_PLUGINS` only seeds
 * this table on first boot. Only plugins an admin has touched have a row —
 * absence means "never toggled" (treated as inactive unless env-seeded).
 */
export const pluginStates = pgTable("plugin_states", {
  id: text("id").primaryKey(),
  active: boolean("active").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Catalog of the tables each plugin owns — populated by the host at load time
 * from every plugin's declared `tables` (already prefixed via `pluginTableName`,
 * e.g. `smtp_mailer_outbox`). With many plugins this is how the admin console
 * shows which table belongs to which plugin, and it gives a future "uninstall"
 * the exact drop-list. Keyed by (plugin_id, table_name).
 */
export const pluginTables = pgTable(
  "plugin_tables",
  {
    pluginId: text("plugin_id").notNull(),
    tableName: text("table_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.tableName] })],
);

export type PluginTable = typeof pluginTables.$inferSelect;
export type NewPluginTable = typeof pluginTables.$inferInsert;

/**
 * What an API key may do. `full`: anything its owner can. `upload`: add posts
 * only (one-shot and resumable uploads), for ingest clients (the browser
 * extension, a phone), so a leaked key can't read private state, edit or delete.
 */
export type ApiKeyScope = "full" | "upload";

/**
 * A long-lived API key for non-browser (Bearer) clients. Like sessions, the DB
 * stores only the sha256 hash of the opaque token (`bnb_…`); the raw key is shown
 * once at creation. No expiry — a key is valid until revoked. Cascades when the
 * owning user is deleted. `lastUsedAt` is a best-effort activity timestamp.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Text + CHECK rather than a pg enum (adding a value later needs no
    // two-pass migration).
    scope: text("scope").$type<ApiKeyScope>().notNull().default("full"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("api_keys_user_idx").on(table.userId),
    check("api_keys_scope_valid", sql`${table.scope} in ('full', 'upload')`),
  ],
);

/**
 * A short-lived, single-use auth token — the shared primitive behind self-serve
 * password reset and email verification. Like sessions/API keys, only the sha256
 * hash of the opaque token is stored (`tokenHash`), never the raw value; the raw
 * token travels in an emailed link and is shown to the user exactly once.
 *
 * `consumedAt` enforces single use (set atomically when the token is redeemed),
 * `expiresAt` bounds the exposure window (30 min), and `requestedIp` is retained
 * for abuse investigation. Cascades when the owning user is deleted; expired rows
 * are reclaimed by a periodic sweep alongside the session GC.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: authTokenPurposeEnum("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Best-effort origin IP of the request that minted the token (abuse forensics);
    // nullable since it may be unknown behind an untrusted proxy.
    requestedIp: text("requested_ip"),
  },
  (table) => [
    index("auth_tokens_user_purpose_idx").on(table.userId, table.purpose),
    // Powers the expired-token reaper (deleteExpired scans by expiry), mirroring
    // the sessions_expires_idx used by session GC.
    index("auth_tokens_expires_idx").on(table.expiresAt),
  ],
);

/** Any JSON value: what a job's payload may hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A job's lifecycle: waiting, claimed by a runner, finished, or out of attempts. */
export type JobStatus = "queued" | "running" | "done" | "failed";

/**
 * The durable job queue. A runner claims due rows with `FOR UPDATE SKIP LOCKED`
 * (several runners never take the same job), leases them until `lockedUntil`
 * (a crashed runner's job becomes claimable again once the lease lapses), and
 * records the outcome: `done`, or a retry at a backed-off `runAt`, or `failed`
 * once `maxAttempts` is spent. `attempts` counts claims, so a crash mid-run
 * still uses up an attempt.
 *
 * `kind` is namespaced by owner (`thumbnailer:thumbnail`). `idempotencyKey`, if
 * set, is unique among PENDING jobs only (queued or running): the same work
 * can't be queued twice at once, but can be queued again after it finishes.
 * Status is text with a CHECK, not a Postgres enum, so a future status is a
 * plain constraint change rather than an `ALTER TYPE` migration.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check("jobs_status_valid", sql`${table.status} in ('queued', 'running', 'done', 'failed')`),
    check("jobs_attempts_nonneg", sql`${table.attempts} >= 0`),
    check("jobs_max_attempts_positive", sql`${table.maxAttempts} >= 1`),
    // The claim scans due work by status and time.
    index("jobs_claim_idx").on(table.status, table.runAt),
    // Admin stats and per-kind claims.
    index("jobs_kind_status_idx").on(table.kind, table.status),
    uniqueIndex("jobs_idempotency_pending_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.status} in ('queued', 'running')`),
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

export type TagAliasRow = typeof tagAliases.$inferSelect;
export type TagImplicationRow = typeof tagImplications.$inferSelect;
export type AssetTagVersionRow = typeof assetTagVersions.$inferSelect;

export type PostView = typeof postViews.$inferSelect;
export type NewPostView = typeof postViews.$inferInsert;

export type DailyVisitor = typeof dailyVisitors.$inferSelect;
export type NewDailyVisitor = typeof dailyVisitors.$inferInsert;

export type UploadSession = typeof uploadSessions.$inferSelect;
export type NewUploadSession = typeof uploadSessions.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;

export type PluginState = typeof pluginStates.$inferSelect;
export type NewPluginState = typeof pluginStates.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type AuthToken = typeof authTokens.$inferSelect;
export type NewAuthToken = typeof authTokens.$inferInsert;

/** Domain enum unions, derived from the pg enums so they can't drift. */
export type Rating = (typeof ratingEnum.enumValues)[number];
export type TagCategory = (typeof tagCategoryEnum.enumValues)[number];
export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type AuthTokenPurpose = (typeof authTokenPurposeEnum.enumValues)[number];

export type Job = typeof jobs.$inferSelect;
