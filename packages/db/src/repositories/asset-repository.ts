import { desc } from "drizzle-orm";

import { assets, type Asset, type NewAsset } from "../schema";
import type { DB } from "../client";

/** Cursor-free page request: `limit` rows starting at `offset`. */
export interface AssetPage {
  limit: number;
  offset: number;
}

/**
 * Data access for {@link Asset} rows — the only place asset SQL lives (per
 * CLAUDE.md: `db` is the sole layer that executes SQL; Repository → Service →
 * Route). It exposes intent-named methods, never raw query builders, so callers
 * can't leak SQL upward.
 */
export interface AssetRepository {
  /** Newest-first page of assets. */
  findMany(page: AssetPage): Promise<Asset[]>;
  /** Total asset count, for pagination metadata. */
  count(): Promise<number>;
  /** Insert one asset, returning the persisted row. */
  create(input: NewAsset): Promise<Asset>;
}

/**
 * Build an {@link AssetRepository} over a {@link DB} handle. The connection is
 * injected (not imported) so the API wires the real database and tests point at
 * a throwaway one — keeping data access free of environment coupling.
 */
export function createAssetRepository(db: DB): AssetRepository {
  return {
    findMany({ limit, offset }) {
      return db.select().from(assets).orderBy(desc(assets.id)).limit(limit).offset(offset);
    },

    count() {
      // Drizzle's $count returns a JS number and isn't capped at int32 like a
      // hand-written `count(*)::int` would be — matters as the table grows.
      return db.$count(assets);
    },

    async create(input) {
      const [row] = await db.insert(assets).values(input).returning();
      if (!row) {
        throw new Error("asset insert returned no row");
      }
      return row;
    },
  };
}
