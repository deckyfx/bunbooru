import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import {
  authTokens,
  sessions,
  users,
  type AuthToken,
  type AuthTokenPurpose,
  type NewAuthToken,
} from "../schema";
import type { DB } from "../client";

/** The transaction handle Drizzle hands the `db.transaction` callback. */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Data access for {@link AuthToken} rows — the single-use, short-lived tokens
 * behind password reset and email verification (the sole SQL layer per
 * CLAUDE.md). Tokens are keyed by the sha256 hash of the opaque value; the raw
 * token never touches the DB.
 *
 * The `consumeFor…` methods deliberately span the `auth_tokens`, `users`, and
 * `sessions` tables inside ONE transaction: redeeming a token and applying its
 * effect (rewriting the password + revoking sessions, or stamping the verified
 * timestamp) must be atomic so a token can never be spent without its effect
 * landing, nor its effect land twice. That cross-table write is genuinely one
 * unit of work, so it lives here rather than being stitched together in a service.
 */
export interface AuthTokenRepository {
  /** Insert a token, returning the persisted row. */
  create(input: NewAuthToken): Promise<AuthToken>;
  /** The token for a hash, or null (regardless of expiry/consumption). */
  findByHash(tokenHash: string): Promise<AuthToken | null>;
  /**
   * Consume every still-outstanding (unconsumed, unexpired) token for a
   * user+purpose by marking it consumed at `at`. Called before minting a new one
   * so only the latest token of a purpose is ever redeemable.
   */
  invalidateOutstanding(userId: number, purpose: AuthTokenPurpose, at: Date): Promise<void>;
  /**
   * Delete up to `limit` tokens expired before `now`; returns how many were
   * removed. Bounded so a backlog is reclaimed over several sweeps.
   */
  deleteExpired(now: Date, limit: number): Promise<number>;
  /**
   * Atomically redeem a valid `password-reset` token: mark it consumed, rewrite
   * the owner's password hash, and revoke ALL their sessions. Returns the owner's
   * id, or null when the token is unknown / wrong-purpose / expired / already
   * consumed. The conditional consume makes concurrent double-redeem impossible.
   */
  consumeForPasswordReset(input: {
    tokenHash: string;
    now: Date;
    newPasswordHash: string;
  }): Promise<number | null>;
  /**
   * Atomically redeem a valid `verify-email` token: mark it consumed and stamp
   * the owner's `email_verified_at`. Returns the owner's id, or null when the
   * token is unknown / wrong-purpose / expired / already consumed.
   */
  consumeForEmailVerification(input: {
    tokenHash: string;
    now: Date;
    verifiedAt: Date;
  }): Promise<number | null>;
}

/**
 * Conditionally consume a token of `purpose`: set `consumed_at = now` only if it
 * is unconsumed AND unexpired, returning the owning user id. A single UPDATE …
 * RETURNING is the atomic gate that guarantees single use even under concurrent
 * redeems (only one UPDATE can flip `consumed_at`).
 */
async function consumeToken(
  tx: Tx,
  tokenHash: string,
  purpose: AuthTokenPurpose,
  now: Date,
): Promise<number | null> {
  const rows = await tx
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: authTokens.userId });
  return rows[0]?.userId ?? null;
}

/** Build an {@link AuthTokenRepository} over a {@link DB} handle. */
export function createAuthTokenRepository(db: DB): AuthTokenRepository {
  return {
    async create(input) {
      const [row] = await db.insert(authTokens).values(input).returning();
      if (!row) {
        throw new Error("auth token insert returned no row");
      }
      return row;
    },

    async findByHash(tokenHash) {
      const [row] = await db
        .select()
        .from(authTokens)
        .where(eq(authTokens.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    },

    async invalidateOutstanding(userId, purpose, at) {
      await db
        .update(authTokens)
        .set({ consumedAt: at })
        .where(
          and(
            eq(authTokens.userId, userId),
            eq(authTokens.purpose, purpose),
            isNull(authTokens.consumedAt),
          ),
        );
    },

    async deleteExpired(now, limit) {
      // Postgres DELETE has no LIMIT — bound it via an id subquery so one sweep
      // never materializes more than `limit` rows regardless of backlog.
      const batch = db
        .select({ id: authTokens.id })
        .from(authTokens)
        .where(lte(authTokens.expiresAt, now))
        .orderBy(authTokens.expiresAt)
        .limit(limit);
      const rows = await db
        .delete(authTokens)
        .where(inArray(authTokens.id, batch))
        .returning({ id: authTokens.id });
      return rows.length;
    },

    async consumeForPasswordReset({ tokenHash, now, newPasswordHash }) {
      return db.transaction(async (tx) => {
        const userId = await consumeToken(tx, tokenHash, "password-reset", now);
        if (userId === null) return null;
        await tx.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, userId));
        // A reset is the remedy for a compromised account — revoke every session
        // so a live attacker session doesn't survive it.
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        return userId;
      });
    },

    async consumeForEmailVerification({ tokenHash, now, verifiedAt }) {
      return db.transaction(async (tx) => {
        const userId = await consumeToken(tx, tokenHash, "verify-email", now);
        if (userId === null) return null;
        await tx.update(users).set({ emailVerifiedAt: verifiedAt }).where(eq(users.id, userId));
        return userId;
      });
    },
  };
}
