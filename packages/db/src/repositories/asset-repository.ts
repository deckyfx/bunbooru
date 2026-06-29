import { desc, eq, type SQL } from "drizzle-orm";

import { assets, type Asset, type NewAsset } from "../schema";
import type { DB } from "../client";

/**
 * Cursor-free page request: `limit` rows starting at `offset`, optionally
 * narrowed by a prebuilt `where` condition (the Search Engine in `@bunbooru/core`
 * compiles a query AST into this — `db` never parses text).
 */
export interface AssetPage {
  limit: number;
  offset: number;
  where?: SQL;
}

/**
 * Data access for {@link Asset} rows — the only place asset SQL lives (per
 * CLAUDE.md: `db` is the sole layer that executes SQL; Repository → Service →
 * Route). It exposes intent-named methods, never raw query builders, so callers
 * can't leak SQL upward.
 */
export interface AssetRepository {
  /** Newest-first page of assets, optionally filtered by `page.where`. */
  findMany(page: AssetPage): Promise<Asset[]>;
  /** Total assets, optionally filtered by the same `where` (for pagination). */
  count(where?: SQL): Promise<number>;
  /** One asset by id, or null. */
  findById(id: number): Promise<Asset | null>;
  /** One asset by its unique sha256 content key, or null (drives dedupe). */
  findBySha256(sha256: string): Promise<Asset | null>;
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
    findMany({ limit, offset, where }) {
      // .where(undefined) is a no-op in Drizzle, so an unfiltered page just omits it.
      return db
        .select()
        .from(assets)
        .where(where)
        .orderBy(desc(assets.id))
        .limit(limit)
        .offset(offset);
    },

    count(where) {
      // $count returns a JS number (not int32-capped) and accepts an optional
      // filter so the total matches the same `where` as the page.
      return db.$count(assets, where);
    },

    async findById(id) {
      const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
      return row ?? null;
    },

    async findBySha256(sha256) {
      const [row] = await db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
      return row ?? null;
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
