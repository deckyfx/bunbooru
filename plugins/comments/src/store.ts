import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";

import type { DB } from "@bunbooru/plugin-sdk";

import { comments, type CommentRow } from "./schema";

/** Post a comment. */
export async function createComment(
  db: DB,
  comment: { assetId: number; authorId: number; authorName: string; body: string },
): Promise<CommentRow> {
  const [row] = await db.insert(comments).values(comment).returning();
  if (!row) throw new Error("comment insert returned no row");
  return row;
}

/** A comment by id, or null. */
export async function findComment(db: DB, id: number): Promise<CommentRow | null> {
  const [row] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  return row ?? null;
}

/** A post's comments, oldest first, keyset-paged by id (`after` = the last id seen). */
export async function listForAsset(
  db: DB,
  { assetId, after, limit }: { assetId: number; after?: number; limit: number },
): Promise<CommentRow[]> {
  return db
    .select()
    .from(comments)
    .where(and(eq(comments.assetId, assetId), after !== undefined ? gt(comments.id, after) : undefined))
    .orderBy(asc(comments.id))
    .limit(limit);
}

/** Every post's comments, newest first, keyset-paged by id (`before` = the last id seen). */
export async function listRecent(db: DB, { before, limit }: { before?: number; limit: number }): Promise<CommentRow[]> {
  return db
    .select()
    .from(comments)
    .where(before !== undefined ? lt(comments.id, before) : undefined)
    .orderBy(desc(comments.id))
    .limit(limit);
}

/**
 * Replace a comment's text and stamp `updated_at`. Null when it no longer
 * exists. `clock_timestamp()` rather than `now()`: an edit in the same
 * transaction as the insert would otherwise not count as an edit.
 */
export async function updateComment(db: DB, id: number, body: string): Promise<CommentRow | null> {
  const [row] = await db
    .update(comments)
    .set({ body, updatedAt: sql`clock_timestamp()` })
    .where(eq(comments.id, id))
    .returning();
  return row ?? null;
}

/** Delete a comment; whether it existed. */
export async function deleteComment(db: DB, id: number): Promise<boolean> {
  const deleted = await db.delete(comments).where(eq(comments.id, id)).returning({ id: comments.id });
  return deleted.length > 0;
}

/** Delete every comment on a post in one statement; returns how many. */
export async function deleteForAsset(db: DB, assetId: number): Promise<number> {
  const deleted = await db.delete(comments).where(eq(comments.assetId, assetId)).returning({ id: comments.id });
  return deleted.length;
}
