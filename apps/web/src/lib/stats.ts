import { useEffect, useRef } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, unwrap } from "./api";

/** Site-wide traffic counters returned by `GET /stats`. */
export interface SiteStats {
  posts: number;
  visitorsToday: number;
}

/** Total posts + today's unique visitors. Polled lazily; safe to call anywhere. */
export function useSiteStats() {
  return useQuery({
    queryKey: ["site-stats"],
    queryFn: async (): Promise<SiteStats> => unwrap(await api.api.v1.stats.get()),
    staleTime: 60_000,
  });
}

/**
 * Record a daily visit once per app load. The server dedupes per (day, visitor),
 * so a StrictMode double-invoke or a re-render is harmless; the ref just avoids
 * the redundant request.
 */
export function useRecordVisit(): void {
  const queryClient = useQueryClient();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    api.api.v1.stats.visit
      .post()
      .then(() => {
        // Refresh the footer/home counters so they include this visit.
        void queryClient.invalidateQueries({ queryKey: ["site-stats"] });
      })
      .catch(() => {
        // A transient failure shouldn't permanently drop the visit — allow a
        // retry on the next mount (the endpoint is deduped per day).
        fired.current = false;
      });
  }, [queryClient]);
}

/**
 * Record a view of `assetId` once it's known. The server debounces per
 * visitor-session, so refreshes don't inflate the count; the ref avoids a
 * duplicate request when the same asset id re-renders.
 */
export function useRecordView(assetId: number | undefined): void {
  const queryClient = useQueryClient();
  const fired = useRef<number | null>(null);
  useEffect(() => {
    if (assetId === undefined || fired.current === assetId) return;
    fired.current = assetId;
    api.api.v1
      .assets({ id: String(assetId) })
      .view.post()
      .then((res) => {
        // Only refetch the asset when the view actually counted (not a throttled
        // repeat), so the detail page shows the incremented viewCount.
        if (res.data && "counted" in res.data && res.data.counted) {
          void queryClient.invalidateQueries({ queryKey: ["asset", assetId] });
        }
      })
      .catch(() => {
        // Allow a retry on a later mount rather than dropping the view.
        fired.current = null;
      });
  }, [assetId, queryClient]);
}
