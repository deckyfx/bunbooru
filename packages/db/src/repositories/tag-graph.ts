import { sql } from "drizzle-orm";

import type { DB } from "../client";
import { bigintArray } from "./sql-arrays";

/** A transaction handle, as Drizzle passes it to `db.transaction`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Advisory-lock key serializing every alias/implication change. Their integrity
 * rules span rows (no alias chains, an acyclic implication graph), and a check
 * followed by a write is only sound if no other gardening change can interleave.
 * Arbitrary but stable, and distinct from the other lock keys in this package.
 */
const TAG_GARDENING_LOCK = 987_654_322;

/** Take the gardening lock for the rest of `tx` (released at commit/rollback). */
export async function lockTagGardening(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${TAG_GARDENING_LOCK})`);
}

/**
 * The ids `tagIds` imply, transitively, excluding the inputs themselves. `UNION`
 * (not `UNION ALL`) dedupes as it recurses, so the walk terminates even on a
 * graph that somehow contains a cycle.
 */
export async function impliedTagIds(tx: Tx | DB, tagIds: readonly number[]): Promise<number[]> {
  if (tagIds.length === 0) return [];
  const rows = await tx.execute<{ id: number | string }>(sql`
    WITH RECURSIVE implied(id) AS (
      SELECT consequent_id FROM tag_implications WHERE antecedent_id = ANY(${bigintArray(tagIds)})
      UNION
      SELECT ti.consequent_id FROM tag_implications ti
        INNER JOIN implied ON ti.antecedent_id = implied.id
    )
    SELECT id FROM implied
  `);
  const inputs = new Set(tagIds);
  return [...rows].map((row) => Number(row.id)).filter((id) => !inputs.has(id));
}
