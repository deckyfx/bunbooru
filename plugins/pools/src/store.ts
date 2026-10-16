import { and, asc, count, desc, eq, gt, ilike, sql } from "drizzle-orm";

import { ConflictError, ValidationError, type DB } from "@bunbooru/plugin-sdk";

import { poolPosts, pools } from "./schema";

/** Most posts one pool may hold (it's rendered in one request). */
export const MAX_POOL_SIZE = 500;

export type PoolRow = typeof pools.$inferSelect;

/** A pool as the list shows it. */
export interface PoolSummary {
  id: number;
  name: string;
  description: string;
  creatorName: string | null;
  postCount: number;
  /** The first post, for a cover image; null for an empty pool. */
  coverAssetId: number | null;
  updatedAt: Date;
}

/** Where a post sits in one pool, for the post page's previous/next links. */
export interface PoolMembership {
  id: number;
  name: string;
  /** 1-based. */
  position: number;
  size: number;
  prevId: number | null;
  nextId: number | null;
}

/** A transaction handle, as Drizzle passes it to `db.transaction`. */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** True for a Postgres unique violation, through Drizzle's / bun-sql's error wrapping. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, errno } = e as { code?: unknown; errno?: unknown };
    if (code === "23505" || errno === "23505") return true;
  }
  return false;
}

/** Turn a name collision into a 409; rethrow anything else. */
function nameConflict(name: string, error: unknown): never {
  if (isUniqueViolation(error)) throw new ConflictError(`A pool named "${name}" already exists`);
  throw error;
}

export async function findPool(db: DB, id: number): Promise<PoolRow | null> {
  const [row] = await db.select().from(pools).where(eq(pools.id, id)).limit(1);
  return row ?? null;
}

/** A pool's id by name, case-insensitively, or null. */
export async function findPoolIdByName(db: DB, name: string): Promise<number | null> {
  const [row] = await db
    .select({ id: pools.id })
    .from(pools)
    .where(sql`lower(${pools.name}) = lower(${name})`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Pools, most recently updated first (ties by id), optionally filtered by a
 * name fragment. Keyset-paged on `(updated_at, id)`: pass the last row's values.
 */
export async function listPools(
  db: DB,
  options: { query?: string; limit: number; before?: { updatedAt: Date; id: number } },
): Promise<PoolSummary[]> {
  const fragment = options.query?.trim().replace(/\s+/g, "_");
  const escaped = fragment?.replace(/[\\%_]/g, "\\$&");
  const rows = await db
    .select({
      id: pools.id,
      name: pools.name,
      description: pools.description,
      creatorName: pools.creatorName,
      updatedAt: pools.updatedAt,
      postCount: sql<number>`(select count(*)::int from ${poolPosts} where ${poolPosts.poolId} = ${pools.id})`,
      coverAssetId: sql<number | null>`(select ${poolPosts.assetId} from ${poolPosts} where ${poolPosts.poolId} = ${pools.id} order by ${poolPosts.position} limit 1)`,
    })
    .from(pools)
    .where(
      and(
        escaped ? ilike(pools.name, `%${escaped}%`) : undefined,
        options.before
          ? sql`(${pools.updatedAt}, ${pools.id}) < (${options.before.updatedAt.toISOString()}::timestamptz, ${options.before.id}::bigint)`
          : undefined,
      ),
    )
    .orderBy(desc(pools.updatedAt), desc(pools.id))
    .limit(options.limit);
  return rows.map((row) => ({ ...row, coverAssetId: row.coverAssetId === null ? null : Number(row.coverAssetId) }));
}

/** The pools `userId` created, by name (for "Add to pool"). */
export function poolsByCreator(db: DB, userId: number) {
  return db
    .select({
      id: pools.id,
      name: pools.name,
      postCount: sql<number>`(select count(*)::int from ${poolPosts} where ${poolPosts.poolId} = ${pools.id})`,
    })
    .from(pools)
    .where(eq(pools.creatorId, userId))
    .orderBy(asc(pools.name))
    .limit(200);
}

export async function createPool(
  db: DB,
  input: { name: string; description: string; creatorId: number; creatorName: string },
): Promise<PoolRow> {
  try {
    const [row] = await db.insert(pools).values(input).returning();
    if (!row) throw new Error("Pool row missing after insert");
    return row;
  } catch (error) {
    return nameConflict(input.name, error);
  }
}

export async function updatePool(
  db: DB,
  id: number,
  patch: { name?: string; description?: string },
): Promise<PoolRow | null> {
  try {
    const [row] = await db
      .update(pools)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(pools.id, id))
      .returning();
    return row ?? null;
  } catch (error) {
    return nameConflict(patch.name ?? "", error);
  }
}

export async function deletePool(db: DB, id: number): Promise<boolean> {
  const removed = await db.delete(pools).where(eq(pools.id, id)).returning({ id: pools.id });
  return removed.length > 0;
}

/** A pool's post ids, in order. */
export async function poolAssetIds(db: DB | Tx, poolId: number): Promise<number[]> {
  const rows = await db
    .select({ assetId: poolPosts.assetId })
    .from(poolPosts)
    .where(eq(poolPosts.poolId, poolId))
    .orderBy(asc(poolPosts.position));
  return rows.map((row) => row.assetId);
}

/**
 * Run `edit` on a pool's posts inside one transaction holding the pool row's
 * lock, so concurrent edits to the same pool serialize and positions stay 1..n,
 * and bump the pool's `updatedAt`. False when the pool doesn't exist.
 */
async function editPosts(db: DB, poolId: number, edit: (tx: Tx) => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: pools.id }).from(pools).where(eq(pools.id, poolId)).for("update");
    if (!locked) return false;
    await edit(tx);
    await tx.update(pools).set({ updatedAt: new Date() }).where(eq(pools.id, poolId));
    return true;
  });
}

/** Replace a pool's posts with exactly `assetIds`, in that order (duplicates dropped). */
export function replacePosts(db: DB, poolId: number, assetIds: readonly number[]): Promise<boolean> {
  const ordered = [...new Set(assetIds)];
  if (ordered.length > MAX_POOL_SIZE) throw new ValidationError(`A pool holds at most ${MAX_POOL_SIZE} posts`);
  return editPosts(db, poolId, async (tx) => {
    await tx.delete(poolPosts).where(eq(poolPosts.poolId, poolId));
    if (ordered.length > 0) {
      await tx.insert(poolPosts).values(ordered.map((assetId, i) => ({ poolId, assetId, position: i + 1 })));
    }
  });
}

/** Add a post at the end of a pool; a post already in it stays where it is. */
export function appendPost(db: DB, poolId: number, assetId: number): Promise<boolean> {
  return editPosts(db, poolId, async (tx) => {
    const [size] = await tx.select({ n: count() }).from(poolPosts).where(eq(poolPosts.poolId, poolId));
    const n = size?.n ?? 0;
    const [present] = await tx
      .select({ id: poolPosts.assetId })
      .from(poolPosts)
      .where(and(eq(poolPosts.poolId, poolId), eq(poolPosts.assetId, assetId)));
    if (present) return;
    if (n >= MAX_POOL_SIZE) throw new ValidationError(`A pool holds at most ${MAX_POOL_SIZE} posts`);
    await tx.insert(poolPosts).values({ poolId, assetId, position: n + 1 });
  });
}

/** Take a post out of a pool, closing the gap so positions stay 1..n. */
export function removePost(db: DB, poolId: number, assetId: number): Promise<boolean> {
  return editPosts(db, poolId, async (tx) => {
    const [removed] = await tx
      .delete(poolPosts)
      .where(and(eq(poolPosts.poolId, poolId), eq(poolPosts.assetId, assetId)))
      .returning({ position: poolPosts.position });
    if (!removed) return;
    await tx
      .update(poolPosts)
      .set({ position: sql`${poolPosts.position} - 1` })
      .where(and(eq(poolPosts.poolId, poolId), gt(poolPosts.position, removed.position)));
  });
}

/** Every pool a post is in, with its position and neighbours there, by name. */
export async function poolsForAsset(db: DB, assetId: number): Promise<PoolMembership[]> {
  const rows = await db.execute<{
    id: number | string;
    name: string;
    position: number;
    size: number | string;
    prev_id: number | string | null;
    next_id: number | string | null;
  }>(sql`
    SELECT p.id, p.name, pp.position,
           (SELECT count(*) FROM ${poolPosts} c WHERE c.pool_id = p.id) AS size,
           (SELECT x.asset_id FROM ${poolPosts} x WHERE x.pool_id = p.id AND x.position = pp.position - 1) AS prev_id,
           (SELECT x.asset_id FROM ${poolPosts} x WHERE x.pool_id = p.id AND x.position = pp.position + 1) AS next_id
      FROM ${poolPosts} pp
      JOIN ${pools} p ON p.id = pp.pool_id
     WHERE pp.asset_id = ${assetId}
     ORDER BY lower(p.name)
  `);
  const num = (v: number | string | null) => (v === null ? null : Number(v));
  return [...rows].map((row) => ({
    id: Number(row.id),
    name: row.name,
    position: Number(row.position),
    size: Number(row.size),
    prevId: num(row.prev_id),
    nextId: num(row.next_id),
  }));
}

