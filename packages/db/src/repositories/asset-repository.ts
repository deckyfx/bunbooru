import { and, asc, desc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";

import { assets, type Asset, type NewAsset } from "../schema";
import type { DB } from "../client";

/** The asset columns a listing can be sorted by (each paired with `id`). */
export type AssetSortKey = "id" | "createdAt" | "viewCount" | "sizeBytes" | "tagCount";

/** How a listing is ordered: by a column (ties broken by id), or shuffled. */
export type AssetOrder =
  | { kind: "column"; key: AssetSortKey; direction: "asc" | "desc" }
  | { kind: "random" };

/**
 * A keyset position: the sort column's value and the id of a row, the page
 * continues strictly past it. `value` is an ISO timestamp for `createdAt`, a
 * number for every other key.
 */
export interface AssetKeyset {
  value: number | string;
  id: number;
}

/**
 * One keyset page request. The Search Engine in `@bunbooru/core` compiles the
 * query into `where` and `order` (`db` never parses text).
 */
export interface AssetPage {
  where?: SQL;
  order: AssetOrder;
  limit: number;
  /** Continue past this row; omitted for the first page. Ignored for random order. */
  after?: AssetKeyset;
  /**
   * Walk TOWARD the start instead (the previous page): rows come back nearest
   * to `after` first. The caller reverses them for display.
   */
  backward?: boolean;
}

/** Each sort key's column and the SQL type its keyset value is bound as. */
const SORT_COLUMNS = {
  id: { column: assets.id, cast: "bigint" },
  createdAt: { column: assets.createdAt, cast: "timestamptz" },
  viewCount: { column: assets.viewCount, cast: "bigint" },
  sizeBytes: { column: assets.sizeBytes, cast: "bigint" },
  tagCount: { column: assets.tagCount, cast: "integer" },
} as const;

/**
 * Data access for {@link Asset} rows — the only place asset SQL lives (per
 * CLAUDE.md: `db` is the sole layer that executes SQL; Repository → Service →
 * Route). It exposes intent-named methods, never raw query builders, so callers
 * can't leak SQL upward.
 */
export interface AssetRepository {
  /**
   * One keyset page of assets in `page.order`, filtered by `page.where`. Cost is
   * independent of how deep the page is (no OFFSET scan).
   */
  findPage(page: AssetPage): Promise<Asset[]>;
  /**
   * How many assets match `where`, counting no further than `cap + 1`: the
   * scan stops there, so the cost is bounded however many rows match. A result
   * above `cap` means "more than cap".
   */
  countUpTo(where: SQL | undefined, cap: number): Promise<number>;
  /** One asset by id, or null. */
  findById(id: number): Promise<Asset | null>;
  /** One asset by its unique sha256 content key, or null (drives dedupe). */
  findBySha256(sha256: string): Promise<Asset | null>;
  /**
   * Of the given `storageKeys`, return the subset that some asset row references.
   * Used by orphan-blob GC to tell which stored objects are still live in one
   * batched query (avoids an N+1 existence check per object).
   */
  findReferencedStorageKeys(storageKeys: string[]): Promise<Set<string>>;
  /** Insert one asset, returning the persisted row. */
  create(input: NewAsset): Promise<Asset>;
  /** Patch a row's mutable metadata, returning the updated row or null if absent. */
  update(id: number, patch: AssetUpdate): Promise<Asset | null>;
  /**
   * Neighbours of an asset in the newest-first (id desc) browse order:
   * `newerId` is the next-higher id (the post shown just before this one),
   * `olderId` the next-lower id. Either is null at the ends. Unfiltered (all posts).
   */
  neighbors(id: number): Promise<{ newerId: number | null; olderId: number | null }>;
}

/** Mutable-after-create asset fields (immutable: dimensions, hashes, storage key). */
export type AssetUpdate = Partial<Pick<NewAsset, "rating" | "source">>;

/**
 * Build an {@link AssetRepository} over a {@link DB} handle. The connection is
 * injected (not imported) so the API wires the real database and tests point at
 * a throwaway one — keeping data access free of environment coupling.
 */
export function createAssetRepository(db: DB): AssetRepository {
  return {
    findPage({ where, order, limit, after, backward = false }) {
      if (order.kind === "random") {
        // No keyset for a shuffle: one page of random matches.
        return db.select().from(assets).where(where).orderBy(sql`random()`).limit(limit);
      }
      const { column, cast } = SORT_COLUMNS[order.key];
      // Walking backward flips the direction, both for the comparison and the
      // ORDER BY, so the rows nearest `after` come first either way.
      const ascending = (order.direction === "asc") !== backward;
      // Row comparison `(col, id) > (v, id)` keeps ties on the sort column in a
      // stable order, and both halves of it use the same composite index.
      const past = after
        ? ascending
          ? sql`(${column}, ${assets.id}) > (${after.value}::${sql.raw(cast)}, ${after.id}::bigint)`
          : sql`(${column}, ${assets.id}) < (${after.value}::${sql.raw(cast)}, ${after.id}::bigint)`
        : undefined;
      const sortDir = ascending ? asc : desc;
      return db
        .select()
        .from(assets)
        .where(and(where, past))
        .orderBy(sortDir(column), sortDir(assets.id))
        .limit(limit);
    },

    async countUpTo(where, cap) {
      // Count a LIMITed subquery, so the scan stops after cap + 1 matches.
      const matches = db
        .select({ one: sql`1` })
        .from(assets)
        .where(where)
        .limit(cap + 1)
        .as("matches");
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(matches);
      return row?.n ?? 0;
    },

    async findById(id) {
      const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
      return row ?? null;
    },

    async findBySha256(sha256) {
      const [row] = await db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
      return row ?? null;
    },

    async findReferencedStorageKeys(storageKeys) {
      if (storageKeys.length === 0) return new Set();
      const rows = await db
        .select({ storageKey: assets.storageKey })
        .from(assets)
        .where(inArray(assets.storageKey, storageKeys));
      return new Set(rows.map((r) => r.storageKey));
    },

    async create(input) {
      const [row] = await db.insert(assets).values(input).returning();
      if (!row) {
        throw new Error("asset insert returned no row");
      }
      return row;
    },

    async update(id, patch) {
      // Always bump updatedAt; the column defaults to now() only on insert.
      const [row] = await db
        .update(assets)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(assets.id, id))
        .returning();
      return row ?? null;
    },

    async neighbors(id) {
      // Two keyset lookups against the id index — cheap and gap-tolerant.
      const [newer] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(gt(assets.id, id))
        .orderBy(asc(assets.id))
        .limit(1);
      const [older] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(lt(assets.id, id))
        .orderBy(desc(assets.id))
        .limit(1);
      return { newerId: newer?.id ?? null, olderId: older?.id ?? null };
    },
  };
}
