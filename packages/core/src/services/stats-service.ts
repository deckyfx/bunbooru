import type { StatsRepository } from "@bunbooru/db";

/** Debounce window for counting a repeat view from the same visitor. */
const VIEW_SESSION_WINDOW_MS = 30 * 60 * 1000; // 30 min

/** A snapshot of site-wide traffic counters for the UI. */
export interface SiteStats {
  /** Total number of posts (assets). */
  posts: number;
  /** Unique visitors recorded so far today (UTC). */
  visitorsToday: number;
}

/**
 * Traffic counting: per-post views (debounced per visitor-session) and daily
 * unique visitors. Stays HTTP-agnostic — the API supplies the opaque
 * `visitorId` (a first-party cookie id) and decides when to call these.
 */
export interface StatsService {
  /** Record a view of `assetId`; returns whether it counted (false = debounced repeat). */
  recordView(visitorId: string, assetId: number): Promise<boolean>;
  /** Record that `visitorId` visited today. */
  recordVisit(visitorId: string): Promise<void>;
  /** Total posts + today's unique visitors. */
  getStats(): Promise<SiteStats>;
}

/**
 * Build a {@link StatsService}. `now` is injectable so tests can pin "today" and
 * the session window deterministically.
 */
export function createStatsService(
  stats: StatsRepository,
  now: () => Date = () => new Date(),
): StatsService {
  /** Today's date as `YYYY-MM-DD` (UTC) — the daily-visitor bucket key. */
  function today(): string {
    return now().toISOString().slice(0, 10);
  }

  return {
    recordView(visitorId, assetId) {
      return stats.recordView(visitorId, assetId, VIEW_SESSION_WINDOW_MS);
    },

    recordVisit(visitorId) {
      return stats.recordVisit(visitorId, today());
    },

    async getStats() {
      const [posts, visitorsToday] = await Promise.all([
        stats.postCount(),
        stats.visitorCount(today()),
      ]);
      return { posts, visitorsToday };
    },
  };
}
