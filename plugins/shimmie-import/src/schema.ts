import { integer, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/** The lifecycle of an import run — constrained at the DB level (no stray values). */
export const importRunStatus = pgEnum("shimmie_import_run_status", ["running", "done", "canceled"]);

/**
 * An import run: one resumable session over a source shimmie, with its config +
 * a cursor so `POST /runs/:id/step` picks up where the last batch stopped (no
 * re-scan from the start) and its progress counters. Plugin-owned.
 */
export const importRuns = pgTable("shimmie_import_runs", {
  id: serial("id").primaryKey(),
  /** Normalized shimmie base URL (origin) — identifies the source instance. */
  sourceInstance: text("source_instance").notNull(),
  /** `*` = all users, else a comma-joined list of shimmie usernames to include. */
  userFilter: text("user_filter").notNull(),
  /** IANA timezone the source's naive "posted" timestamps are in (default UTC). */
  sourceTimezone: text("source_timezone").notNull().default("UTC"),
  /** Target bunbooru user the imported posts are attributed to. */
  targetUserId: integer("target_user_id").notNull(),
  /** Highest source post id to scan (read once at start from /post/list/1). */
  maxId: integer("max_id").notNull(),
  /** Last source post id scanned; the next step resumes at `cursor + 1`. */
  cursor: integer("cursor").notNull().default(0),
  imported: integer("imported").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  status: importRunStatus("status").notNull().default("running"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-source-post idempotency ledger: one row per (sourceInstance, sourcePostId)
 * actually processed, so a re-run (or a second run) never re-ingests a completed
 * post. Correctness also rides on Core's sha256 dedupe; this ledger avoids the
 * wasted re-fetch/re-tag and records the source→asset mapping. (A lease/owner
 * claim for concurrent runs is deferred — single-admin/single-instance.)
 */
export const importItems = pgTable(
  "shimmie_import_items",
  {
    id: serial("id").primaryKey(),
    sourceInstance: text("source_instance").notNull(),
    sourcePostId: integer("source_post_id").notNull(),
    /** The bunbooru asset created (or deduped onto); null on failure. */
    assetId: integer("asset_id"),
    /** `complete` | `failed`. */
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.sourceInstance, table.sourcePostId)],
);
