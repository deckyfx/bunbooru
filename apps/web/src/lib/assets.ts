import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AssetDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

/** Grid page size. */
export const ASSETS_PER_PAGE = 42;

export type { AssetDto };

/**
 * Newest-first page of assets. Eden Treaty is the transport; TanStack Query owns
 * caching + loading/error state. The `error` discriminant narrows `data` to
 * non-null, so the hook resolves a fully-typed page.
 */
export function useAssetsPage(page: number) {
  return useQuery({
    queryKey: ["assets", page],
    enabled: Number.isInteger(page) && page > 0,
    queryFn: async () =>
      unwrap(await api.api.v1.assets.get({ query: { page, per_page: ASSETS_PER_PAGE } })),
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
