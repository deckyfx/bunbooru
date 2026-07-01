import { and, eq, gt, inArray, lte } from "drizzle-orm";

import { sessions, type NewSession, type Session } from "../schema";
import type { DB } from "../client";

/**
 * Data access for login {@link Session} rows. Sessions are keyed by the sha256
 * hash of an opaque token (the raw token never touches the DB). The only SQL
 * layer per CLAUDE.md.
 */
export interface SessionRepository {
  /** Open a session. */
  create(input: NewSession): Promise<Session>;
  /**
   * The session for `tokenHash` if it exists AND hasn't expired at `now`, else
   * null — so an expired session reads as logged-out without a separate sweep.
   */
  findValidByTokenHash(tokenHash: string, now: Date): Promise<Session | null>;
  /** Delete a session by token hash (logout/revoke; no-op if already gone). */
  deleteByTokenHash(tokenHash: string): Promise<void>;
  /**
   * Delete up to `limit` sessions expired before `now`; returns how many were
   * removed. Bounded by design so a large backlog is reclaimed over several
   * sweeps in constant memory rather than materialized all at once.
   */
  deleteExpired(now: Date, limit: number): Promise<number>;
}

/** Build a {@link SessionRepository} over a {@link DB} handle. */
export function createSessionRepository(db: DB): SessionRepository {
  return {
    async create(input) {
      const [row] = await db.insert(sessions).values(input).returning();
      if (!row) {
        throw new Error("session insert returned no row");
      }
      return row;
    },

    async findValidByTokenHash(tokenHash, now) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
        .limit(1);
      return row ?? null;
    },

    async deleteByTokenHash(tokenHash) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },

    async deleteExpired(now, limit) {
      // Postgres DELETE has no LIMIT — bound it by deleting the oldest `limit`
      // expired ids via a subquery, so one sweep never materializes more than
      // `limit` rows regardless of backlog size.
      // `<= now` (not `<`) mirrors findValidByTokenHash's `expiresAt > now`
      // validity test: a session whose expiry is exactly `now` reads as expired
      // there, so GC must reclaim it too rather than leave it for a later sweep.
      const batch = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(lte(sessions.expiresAt, now))
        .orderBy(sessions.expiresAt)
        .limit(limit);
      const rows = await db
        .delete(sessions)
        .where(inArray(sessions.id, batch))
        .returning({ id: sessions.id });
      return rows.length;
    },
  };
}
