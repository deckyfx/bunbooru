import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AssetDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

/** Grid page size. */
export const ASSETS_PER_PAGE = 42;

export type { AssetDto };

/**
 * One keyset page of assets for the booru search query `q` (tags/metatags,
 * including `order:`; the API compiles it to SQL), starting at `cursor` (a
 * previous page's `nextCursor`/`prevCursor`; omit for the first page). Eden
 * Treaty is the transport; TanStack Query owns caching + loading/error state.
 */
export function useAssetsPage(q?: string, cursor?: string) {
  const query = q?.trim() ? q.trim() : undefined;
  return useQuery({
    queryKey: ["assets", query ?? null, cursor ?? null],
    queryFn: async () =>
      unwrap(
        await api.api.v1.assets.get({
          query: {
            per_page: ASSETS_PER_PAGE,
            ...(query ? { q: query } : {}),
            ...(cursor ? { cursor } : {}),
          },
        }),
      ),
  });
}

/** The search for `username`'s posts that have no tags yet: the triage queue. */
export const untaggedQuery = (username: string): string => `user:${username} tagcount:0`;

/**
 * How many of `username`'s posts still need tags (capped like every count).
 * One row fetched; the count is what's wanted. Off for a signed-out viewer.
 */
export function useUntaggedCount(username: string | undefined) {
  return useQuery({
    queryKey: ["assets", "untagged-count", username ?? null],
    enabled: username !== undefined,
    staleTime: 30_000,
    queryFn: async () => {
      const page = unwrap(
        await api.api.v1.assets.get({ query: { per_page: 1, q: untaggedQuery(username ?? "") } }),
      );
      return { total: page.total, capped: page.totalCapped };
    },
  });
}

/** A single asset's metadata (for the detail page / deep links). */
export function useAsset(id: number) {
  return useQuery({
    queryKey: ["asset", id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: async () => {
      const res = await api.api.v1.assets({ id: String(id) }).get();
      // A 404 is "this asset doesn't exist" — a normal not-found state, not a
      // query failure. Return null so the detail page renders NotFound instead
      // of the generic error/retry UI; other errors still throw via unwrap.
      if (res.status === 404) return null;
      return unwrap(res);
    },
  });
}

/**
 * The neighbouring post ids in the newest-first browse order — `newerId` (the
 * post shown just before this one) and `olderId` (just after). Null at the ends.
 * Drives the detail page's prev/next navigation.
 */
export function usePostNeighbors(id: number) {
  return useQuery({
    queryKey: ["asset-neighbors", id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: async () => unwrap(await api.api.v1.assets({ id: String(id) }).neighbors.get()),
  });
}

/** Mutable asset metadata a client may patch (rating/source). */
export type AssetPatch = { rating?: AssetDto["rating"]; source?: string | null };

/**
 * Edit an asset's metadata via `PATCH /assets/:id` (Eden). On success refreshes
 * both the detail query and the gallery lists so the change shows everywhere.
 */
export function useUpdateAsset(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: AssetPatch) => unwrap(await api.api.v1.assets({ id: String(id) }).patch(patch)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["asset", id] }),
        queryClient.invalidateQueries({ queryKey: ["assets"] }),
      ]);
    },
  });
}

/**
 * Delete a post for good via `DELETE /assets/:id` (Eden), with an optional
 * reason for the tombstone. A 204 has no body, so this checks `res.error`
 * instead of `unwrap`. On success: mark the gallery lists (and every cached
 * prev/next, which may point at this post) stale, run `onDeleted` (the page
 * navigates away), and only THEN drop the post's own query, so the
 * still-mounted detail page never refetches it into a "not found" flash.
 */
export function useDeleteAsset(id: number, onDeleted: () => void | Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) => {
      const trimmed = reason.trim();
      const res = await api.api.v1.assets({ id: String(id) }).delete(trimmed ? { reason: trimmed } : {});
      if (res.error) throw res.error;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["assets"] }),
        queryClient.invalidateQueries({ queryKey: ["asset-neighbors"] }),
      ]);
      await onDeleted();
      queryClient.removeQueries({ queryKey: ["asset", id] });
    },
  });
}
