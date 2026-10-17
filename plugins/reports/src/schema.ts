import { sql } from "drizzle-orm";
import { bigint, bigserial, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** A report's lifecycle: waiting in the queue, acted on, or turned down. */
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * One user's report of a post. `assetId` and `reporterId` mirror Core's
 * `assets.id` / `users.id` with no cross-schema foreign keys (a deleted post is
 * handled by the `asset.deleted` listener); `reporterName` and
 * `resolvedByName` are copied since the plugin can't read Core's users table.
 * `status` is text + CHECK rather than a pg enum, so adding a state later is a
 * plain constraint swap.
 */
export const reports = pgTable(
  "reports_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    assetId: bigint("asset_id", { mode: "number" }).notNull(),
    reporterId: bigint("reporter_id", { mode: "number" }),
    reporterName: text("reporter_name"),
    reason: text("reason").notNull(),
    status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
    resolution: text("resolution"),
    resolvedByName: text("resolved_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    // One OPEN report per user per post; once it's handled they may report again.
    uniqueIndex("reports_reports_open_reporter_idx")
      .on(table.assetId, table.reporterId)
      .where(sql`${table.status} = 'open'`),
    // The moderator queue: one status, newest first, keyset by id.
    index("reports_reports_queue_idx").on(table.status, table.id.desc()),
    index("reports_reports_asset_idx").on(table.assetId),
    check("reports_reports_status_check", sql`${table.status} in ('open', 'resolved', 'dismissed')`),
  ],
);

export type ReportRow = typeof reports.$inferSelect;
