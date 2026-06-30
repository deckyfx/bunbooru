import { eq, lte, sql } from "drizzle-orm";

import { assets, dailyVisitors, postViews } from "../schema";
import type { DB } from "../client";

/**
 * Read/write the lightweight traffic counters — per-post views and daily unique
 * visitors. Both dedupe by an opaque `visitorId` (a first-party cookie id, never
 * a raw IP), so refreshes and repeat visits don't inflate the numbers. The only
 * place this SQL lives (Repository → Service → Route).
 */
export interface StatsRepository {
  /**
   * Record a view of `assetId` by `visitorId`, debounced to once per
   * `sessionWindowMs`. Bumps `assets.view_count` only when it actually counts;
   * returns whether it counted (false = a repeat within the window). Throws if
   * the asset doesn't exist (FK) — callers verify first.
   */
  recordView(visitorId: string, assetId: number, sessionWindowMs: number): Promise<boolean>;
  /** Record a visit for `day` (YYYY-MM-DD) by `visitorId`; idempotent per (day, visitor). */
  recordVisit(visitorId: string, day: string): Promise<void>;
  /** Count of unique visitors recorded for `day`. */
  visitorCount(day: string): Promise<number>;
  /** Total number of posts (assets). */
  postCount(): Promise<number>;
}

/** Build a {@link StatsRepository} over a {@link DB} handle. */
export function createStatsRepository(db: DB): StatsRepository {
  return {
    async recordView(visitorId, assetId, sessionWindowMs) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const cutoff = new Date(now.getTime() - sessionWindowMs);
        // Upsert the dedup row, but only "touch" an existing one when its last
        // count is older than the window. Postgres returns a row from RETURNING
        // exactly when it inserted OR the conditional DO UPDATE fired — i.e. when
        // we should count. A repeat within the window matches the conflict with a
        // false WHERE, updates nothing, and returns no row.
        const counted = await tx
          .insert(postViews)
          .values({ visitorId, assetId, countedAt: now })
          .onConflictDoUpdate({
            target: [postViews.visitorId, postViews.assetId],
            set: { countedAt: now },
            // `<=`: re-count when a full window has elapsed (once-per-window).
            setWhere: lte(postViews.countedAt, cutoff),
          })
          .returning({ visitorId: postViews.visitorId });

        if (counted.length === 0) return false;
        await tx
          .update(assets)
          .set({ viewCount: sql`${assets.viewCount} + 1` })
          .where(eq(assets.id, assetId));
        return true;
      });
    },

    async recordVisit(visitorId, day) {
      await db.insert(dailyVisitors).values({ day, visitorId }).onConflictDoNothing();
    },

    visitorCount(day) {
      return db.$count(dailyVisitors, eq(dailyVisitors.day, day));
    },

    postCount() {
      return db.$count(assets);
    },
  };
}
