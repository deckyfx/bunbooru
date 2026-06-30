import { and, eq, inArray, lt } from "drizzle-orm";

import { uploadSessions, type NewUploadSession, type UploadSession } from "../schema";
import type { DB } from "../client";

/**
 * Data access for {@link UploadSession} rows — the resumable-upload bookkeeping
 * (per CLAUDE.md: `db` is the sole SQL layer). The Core's `UploadService`
 * composes this with a staging store; nothing here touches the filesystem.
 */
export interface UploadSessionRepository {
  /** Open a new session. */
  create(input: NewUploadSession): Promise<UploadSession>;
  /** Look up a session by its public token, or null. */
  findByToken(token: string): Promise<UploadSession | null>;
  /**
   * Compare-and-swap the committed byte count: advance to `uploadedSize` only if
   * the row is still at `expectedUploadedSize`. Returns the updated row, or null
   * if the session is gone OR a concurrent writer already advanced it (so a stale
   * writer can't silently overwrite session state).
   */
  setOffset(
    token: string,
    expectedUploadedSize: number,
    uploadedSize: number,
  ): Promise<UploadSession | null>;
  /** Delete a session by token (no-op if already gone). */
  delete(token: string): Promise<void>;
  /**
   * Delete up to `limit` sessions whose `expiresAt` is before `now` (oldest
   * first); returns each removed session's `token` (to serialize staging cleanup
   * under its lock) and `stagingKey` (the object to remove). `limit` bounds the
   * result set + downstream cleanup per call so a large backlog is drained in
   * batches rather than one unbounded delete; omit it to delete all at once.
   */
  deleteExpired(now: Date, limit?: number): Promise<{ token: string; stagingKey: string }[]>;
}

/** Build an {@link UploadSessionRepository} over a {@link DB} handle. */
export function createUploadSessionRepository(db: DB): UploadSessionRepository {
  return {
    async create(input) {
      const [row] = await db.insert(uploadSessions).values(input).returning();
      if (!row) {
        throw new Error("upload session insert returned no row");
      }
      return row;
    },

    async findByToken(token) {
      const [row] = await db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.token, token))
        .limit(1);
      return row ?? null;
    },

    async setOffset(token, expectedUploadedSize, uploadedSize) {
      const [row] = await db
        .update(uploadSessions)
        .set({ uploadedSize, updatedAt: new Date() })
        .where(
          and(
            eq(uploadSessions.token, token),
            eq(uploadSessions.uploadedSize, expectedUploadedSize),
          ),
        )
        .returning();
      return row ?? null;
    },

    async delete(token) {
      await db.delete(uploadSessions).where(eq(uploadSessions.token, token));
    },

    async deleteExpired(now, limit) {
      if (limit === undefined) {
        return db
          .delete(uploadSessions)
          .where(lt(uploadSessions.expiresAt, now))
          .returning({ token: uploadSessions.token, stagingKey: uploadSessions.stagingKey });
      }
      // Postgres DELETE has no LIMIT, so pick the oldest `limit` expired ids in a
      // subquery and delete exactly those.
      const batch = db
        .select({ id: uploadSessions.id })
        .from(uploadSessions)
        .where(lt(uploadSessions.expiresAt, now))
        .orderBy(uploadSessions.expiresAt)
        .limit(limit);
      return db
        .delete(uploadSessions)
        .where(inArray(uploadSessions.id, batch))
        .returning({ token: uploadSessions.token, stagingKey: uploadSessions.stagingKey });
    },
  };
}
