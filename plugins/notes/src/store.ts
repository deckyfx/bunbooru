import { asc, count, eq, sql } from "drizzle-orm";

import { ConflictError, type DB } from "@bunbooru/plugin-sdk";

import type { NoteBox } from "./geometry";
import { notes, type NoteRow } from "./schema";

/** Most notes one post may carry. */
export const MAX_NOTES_PER_POST = 100;

/**
 * Add a note, refusing (409) once the post has {@link MAX_NOTES_PER_POST}.
 *
 * Count and insert run in one transaction holding a per-post advisory lock
 * (the two-key space, namespaced by the table name), so concurrent adds to a
 * post serialize and can't both pass the count. Released at commit.
 */
export async function createNote(
  db: DB,
  note: NoteBox & { assetId: number; authorId: number; authorName: string; body: string },
): Promise<NoteRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('notes_notes'), hashtext(${String(note.assetId)}))`);
    const [size] = await tx.select({ n: count() }).from(notes).where(eq(notes.assetId, note.assetId));
    if ((size?.n ?? 0) >= MAX_NOTES_PER_POST) {
      throw new ConflictError(`A post can have at most ${MAX_NOTES_PER_POST} notes`);
    }
    const [row] = await tx.insert(notes).values(note).returning();
    if (!row) throw new Error("note insert returned no row");
    return row;
  });
}

/** A note by id, or null. */
export async function findNote(db: DB, id: number): Promise<NoteRow | null> {
  const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  return row ?? null;
}

/** A post's notes in reading order: top to bottom, then left to right (id breaks ties). */
export async function listForAsset(db: DB, assetId: number): Promise<NoteRow[]> {
  return db
    .select()
    .from(notes)
    .where(eq(notes.assetId, assetId))
    .orderBy(asc(notes.y), asc(notes.x), asc(notes.id));
}

/**
 * Change a note's box and/or text and stamp `updated_at`. Null when it no
 * longer exists. `clock_timestamp()`, not `now()`, so an edit in the insert's
 * transaction still moves the stamp.
 */
export async function updateNote(
  db: DB,
  id: number,
  changes: Partial<NoteBox> & { body?: string },
): Promise<NoteRow | null> {
  const [row] = await db
    .update(notes)
    .set({ ...changes, updatedAt: sql`clock_timestamp()` })
    .where(eq(notes.id, id))
    .returning();
  return row ?? null;
}

/** Delete a note; whether it existed. */
export async function deleteNote(db: DB, id: number): Promise<boolean> {
  const deleted = await db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
  return deleted.length > 0;
}

/** Delete every note on a post in one statement; returns how many. */
export async function deleteForAsset(db: DB, assetId: number): Promise<number> {
  const deleted = await db.delete(notes).where(eq(notes.assetId, assetId)).returning({ id: notes.id });
  return deleted.length;
}
