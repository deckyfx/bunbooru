import { desc, eq, lt, or, type SQL } from "drizzle-orm";

import { ConflictError, type DB } from "@bunbooru/plugin-sdk";

import type { BanHashes } from "./hashes";
import { bannedHashes, type BanRow } from "./schema";

/** True for a Postgres unique violation, through Drizzle's / bun-sql's error wrapping. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, errno } = e as { code?: unknown; errno?: unknown };
    if (code === "23505" || errno === "23505") return true;
  }
  return false;
}

/** The ban matching either hash, or null. One indexed lookup per upload. */
export async function findBan(db: DB, { sha256, md5 }: BanHashes): Promise<BanRow | null> {
  const conditions: SQL[] = [];
  if (sha256) conditions.push(eq(bannedHashes.sha256, sha256));
  if (md5) conditions.push(eq(bannedHashes.md5, md5));
  if (conditions.length === 0) return null;
  const [row] = await db
    .select()
    .from(bannedHashes)
    .where(or(...conditions))
    .limit(1);
  return row ?? null;
}

/** Ban `hashes`. 409 when either is already banned. */
export async function createBan(
  db: DB,
  hashes: BanHashes,
  meta: { reason: string; bannedById: number; bannedByName: string },
): Promise<BanRow> {
  try {
    const [row] = await db
      .insert(bannedHashes)
      .values({ ...hashes, ...meta })
      .returning();
    if (!row) throw new Error("ban insert returned no row");
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That file is already banned");
    throw error;
  }
}

/** Lift a ban; false if there was none with that id. */
export async function deleteBan(db: DB, id: number): Promise<boolean> {
  const removed = await db.delete(bannedHashes).where(eq(bannedHashes.id, id)).returning({ id: bannedHashes.id });
  return removed.length > 0;
}

/** Newest bans first, keyset-paged by id. */
export async function listBans(db: DB, { before, limit }: { before?: number; limit: number }): Promise<BanRow[]> {
  return db
    .select()
    .from(bannedHashes)
    .where(before !== undefined ? lt(bannedHashes.id, before) : undefined)
    .orderBy(desc(bannedHashes.id))
    .limit(limit);
}
