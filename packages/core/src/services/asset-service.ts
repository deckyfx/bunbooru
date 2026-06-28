import type { Asset, AssetRepository } from "@bunbooru/db";

/** Default and ceiling page sizes — the ceiling bounds the cost of one query. */
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

/** A page of assets plus the metadata a client needs to render pagination. */
export interface AssetListPage {
  assets: Asset[];
  /** Total assets across all pages. */
  total: number;
  /** 1-based page number actually served (after clamping). */
  page: number;
  /** Page size actually served (after clamping). */
  perPage: number;
  /** Total number of pages for `total` at `perPage` (0 when empty). */
  pageCount: number;
}

/** Optional, possibly out-of-range paging input from the transport layer. */
export interface ListAssetsOptions {
  page?: number;
  perPage?: number;
}

/**
 * Application logic for assets. Holds no SQL — it composes an
 * {@link AssetRepository} and owns request-shaping rules (pagination clamping)
 * so every transport (HTTP now, others later) gets identical behaviour.
 */
export interface AssetService {
  list(options?: ListAssetsOptions): Promise<AssetListPage>;
}

/** Clamp to an integer ≥ 1, falling back to `fallback` for missing/invalid input. */
function toPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored < 1 ? fallback : floored;
}

/** Build an {@link AssetService} over the given repository. */
export function createAssetService(repository: AssetRepository): AssetService {
  return {
    async list(options = {}) {
      const page = toPositiveInt(options.page, 1);
      const perPage = Math.min(toPositiveInt(options.perPage, DEFAULT_PER_PAGE), MAX_PER_PAGE);
      const offset = (page - 1) * perPage;

      // Count and page in parallel — they're independent reads.
      const [list, total] = await Promise.all([
        repository.findMany({ limit: perPage, offset }),
        repository.count(),
      ]);

      return {
        assets: list,
        total,
        page,
        perPage,
        pageCount: Math.ceil(total / perPage),
      };
    },
  };
}
