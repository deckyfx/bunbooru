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
   * Record a view of `assetId` by `visitorId`, throttled to at most once per
   * `windowMs` *since the last counted view*. Bumps `assets.view_count` only
   * when it counts; returns whether it counted (false = a repeat inside the
   * window). Throws if the asset doesn't exist (FK) — callers verify first.
   */
  recordView(visitorId: string, assetId: number, windowMs: number): Promise<boolean>;
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
    async recordView(visitorId, assetId, windowMs) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const cutoff = new Date(now.getTime() - windowMs);
        // Upsert the throttle row, advancing `counted_at` only when the prior
        // count is at/older than the cutoff. Postgres returns a row from RETURNING
        // exactly when it inserted OR the conditional DO UPDATE fired — i.e. when
        // we count. A repeat inside the window matches the conflict with a false
        // WHERE, updates nothing (so `counted_at` stays at the last *counted*
        // view — intermediate hits don't extend the window), and returns no row.
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
