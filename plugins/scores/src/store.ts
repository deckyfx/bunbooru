import { and, eq, sql } from "drizzle-orm";

import type { DB } from "@bunbooru/plugin-sdk";

import { totals, votes } from "./schema";
import { toVote, voteDelta, type ScoreStatus, type Vote } from "./votes";

/** A post's totals, 0/0/0 when nobody has voted on it. */
async function totalsOf(db: DB, assetId: number): Promise<{ score: number; up: number; down: number }> {
  const [row] = await db
    .select({ score: totals.score, up: totals.up, down: totals.down })
    .from(totals)
    .where(eq(totals.assetId, assetId));
  return row ?? { score: 0, up: 0, down: 0 };
}

/** `userId`'s vote on `assetId`, 0 when none (or anonymous). */
async function voteOf(db: DB, assetId: number, userId: number | null): Promise<Vote> {
  if (userId === null) return 0;
  const [row] = await db
    .select({ value: votes.value })
    .from(votes)
    .where(and(eq(votes.assetId, assetId), eq(votes.userId, userId)));
  return row ? (toVote(row.value) ?? 0) : 0;
}

/** A post's score and `userId`'s own vote on it: two primary-key lookups. */
export async function scoreStatus(db: DB, assetId: number, userId: number | null): Promise<ScoreStatus> {
  const [sums, mine] = await Promise.all([totalsOf(db, assetId), voteOf(db, assetId, userId)]);
  return { ...sums, mine };
}

/**
 * Set `userId`'s vote on `assetId` to `next` (0 removes it) and move the
 * post's totals by the difference, in ONE transaction.
 *
 * The post's totals row is created if missing, then locked (`FOR UPDATE`)
 * before the old vote is read. That lock serializes every vote change on the
 * post, so two concurrent voters can't both read the same old state and lose
 * an update; under READ COMMITTED each later statement sees what the previous
 * lock holder committed. One row lock per transaction, so no deadlocks.
 */
export async function castVote(db: DB, assetId: number, userId: number, next: Vote): Promise<ScoreStatus> {
  return db.transaction(async (tx) => {
    await tx.insert(totals).values({ assetId }).onConflictDoNothing();
    await tx.select({ assetId: totals.assetId }).from(totals).where(eq(totals.assetId, assetId)).for("update");

    const mine = and(eq(votes.assetId, assetId), eq(votes.userId, userId));
    const [existing] = await tx.select({ value: votes.value }).from(votes).where(mine);
    const previous = existing ? (toVote(existing.value) ?? 0) : 0;

    if (next === 0) {
      await tx.delete(votes).where(mine);
    } else {
      await tx
        .insert(votes)
        .values({ assetId, userId, value: next })
        .onConflictDoUpdate({ target: [votes.assetId, votes.userId], set: { value: next } });
    }

    const delta = voteDelta(previous, next);
    const [updated] = await tx
      .update(totals)
      .set({
        score: sql`${totals.score} + ${delta.score}`,
        up: sql`${totals.up} + ${delta.up}`,
        down: sql`${totals.down} + ${delta.down}`,
      })
      .where(eq(totals.assetId, assetId))
      .returning({ score: totals.score, up: totals.up, down: totals.down });
    if (!updated) throw new Error("scores_totals row vanished under its own lock");
    return { ...updated, mine: next };
  });
}

/**
 * Drop every vote on a post, and its totals (it was deleted). Totals first:
 * that takes the same row lock {@link castVote} takes, in the same order
 * (totals, then votes), so a vote in flight can't deadlock against this.
 */
export async function removeAssetScores(db: DB, assetId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(totals).where(eq(totals.assetId, assetId));
    await tx.delete(votes).where(eq(votes.assetId, assetId));
  });
}
