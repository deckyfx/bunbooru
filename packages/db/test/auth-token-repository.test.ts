import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAuthTokenRepository,
  createDb,
  createSessionRepository,
  createUserRepository,
  type AuthTokenRepository,
  type DB,
  type SessionRepository,
  type User,
  type UserRepository,
} from "../src/index";

/**
 * Integration tests (opt-in `TEST_DATABASE_URL`) for the auth-token repository and
 * the user-repository additions behind password reset + email verification:
 * single-use consumption, atomic password rewrite + session revocation, verified
 * stamping, outstanding-token invalidation, expiry GC, and cascade-on-user-delete.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

const MINUTE = 60 * 1000;
const sha256 = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("auth-token repository (integration)", () => {
  let db: DB;
  let users: UserRepository;
  let sessions: SessionRepository;
  let tokens: AuthTokenRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    users = createUserRepository(db);
    sessions = createSessionRepository(db);
    tokens = createAuthTokenRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE users, sessions, auth_tokens RESTART IDENTITY CASCADE`);
  });

  async function seedUser(email: string | null = "alice@example.com"): Promise<User> {
    return users.create({ username: "alice", email, passwordHash: "old-hash", role: "member" });
  }

  async function mint(user: User, purpose: "password-reset" | "verify-email", raw: string, ttlMs = 30 * MINUTE) {
    return tokens.create({
      userId: user.id,
      purpose,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + ttlMs),
      requestedIp: "203.0.113.1",
    });
  }

  it("creates and finds a token by hash", async () => {
    const user = await seedUser();
    const row = await mint(user, "password-reset", "raw-1");
    expect(row.id).toBeGreaterThan(0);
    expect(await tokens.findByHash(sha256("raw-1"))).toMatchObject({ id: row.id, purpose: "password-reset" });
    expect(await tokens.findByHash("nope")).toBeNull();
  });

  it("consumeForPasswordReset rewrites the password, revokes sessions, and is single-use", async () => {
    const user = await seedUser();
    await sessions.create({
      userId: user.id,
      tokenHash: sha256("session-1"),
      expiresAt: new Date(Date.now() + MINUTE),
    });
    await mint(user, "password-reset", "raw-1");

    const now = new Date();
    const userId = await tokens.consumeForPasswordReset({
      tokenHash: sha256("raw-1"),
      now,
      newPasswordHash: "new-hash",
    });
    expect(userId).toBe(user.id);

    // Password rewritten, all sessions revoked.
    expect((await users.findById(user.id))?.passwordHash).toBe("new-hash");
    expect(await sessions.findValidByTokenHash(sha256("session-1"), now)).toBeNull();

    // Second redeem fails (already consumed).
    expect(
      await tokens.consumeForPasswordReset({
        tokenHash: sha256("raw-1"),
        now,
        newPasswordHash: "newer-hash",
      }),
    ).toBeNull();
  });

  it("rejects an expired or wrong-purpose token on consume", async () => {
    const user = await seedUser();
    await mint(user, "verify-email", "verify-raw"); // wrong purpose for reset
    await mint(user, "password-reset", "expired-raw", -MINUTE); // already expired

    const now = new Date();
    expect(
      await tokens.consumeForPasswordReset({ tokenHash: sha256("verify-raw"), now, newPasswordHash: "x" }),
    ).toBeNull();
    expect(
      await tokens.consumeForPasswordReset({ tokenHash: sha256("expired-raw"), now, newPasswordHash: "x" }),
    ).toBeNull();
  });

  it("consumeForEmailVerification stamps email_verified_at once", async () => {
    const user = await seedUser();
    await mint(user, "verify-email", "verify-raw");
    expect((await users.findById(user.id))?.emailVerifiedAt).toBeNull();

    const verifiedAt = new Date();
    expect(
      await tokens.consumeForEmailVerification({ tokenHash: sha256("verify-raw"), now: verifiedAt, verifiedAt }),
    ).toBe(user.id);
    expect((await users.findById(user.id))?.emailVerifiedAt).not.toBeNull();

    // Single-use.
    expect(
      await tokens.consumeForEmailVerification({ tokenHash: sha256("verify-raw"), now: verifiedAt, verifiedAt }),
    ).toBeNull();
  });

  it("invalidateOutstanding consumes only that user+purpose", async () => {
    const user = await seedUser();
    await mint(user, "password-reset", "reset-raw");
    await mint(user, "verify-email", "verify-raw");

    await tokens.invalidateOutstanding(user.id, "password-reset", new Date());

    // The reset token is now unredeemable; the verify one is untouched.
    expect(
      await tokens.consumeForPasswordReset({ tokenHash: sha256("reset-raw"), now: new Date(), newPasswordHash: "x" }),
    ).toBeNull();
    expect((await tokens.findByHash(sha256("verify-raw")))?.consumedAt).toBeNull();
  });

  it("deleteExpired reclaims only expired rows, bounded by the limit", async () => {
    const user = await seedUser();
    await mint(user, "password-reset", "e1", -MINUTE);
    await mint(user, "password-reset", "e2", -2 * MINUTE);
    await mint(user, "password-reset", "live", MINUTE);

    const now = new Date();
    expect(await tokens.deleteExpired(now, 1)).toBe(1); // bounded
    expect(await tokens.deleteExpired(now, 100)).toBe(1); // remaining expired
    expect(await tokens.findByHash(sha256("live"))).not.toBeNull();
  });

  it("cascades: deleting the user removes its tokens", async () => {
    const user = await seedUser();
    await mint(user, "password-reset", "raw-1");
    await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    expect(await tokens.findByHash(sha256("raw-1"))).toBeNull();
  });

  describe("user repository additions", () => {
    it("finds by email case-insensitively and never matches a null email", async () => {
      await seedUser("Alice@Example.com");
      expect(await users.findByEmail("alice@example.com")).not.toBeNull();
      expect(await users.findByEmail("nobody@example.com")).toBeNull();

      await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
      await seedUser(null);
      expect(await users.findByEmail("")).toBeNull();
    });

    it("setPasswordHash and setEmailVerifiedAt update the row", async () => {
      const user = await seedUser();
      await users.setPasswordHash(user.id, "rehashed");
      expect((await users.findById(user.id))?.passwordHash).toBe("rehashed");

      const at = new Date("2026-06-01T00:00:00.000Z");
      await users.setEmailVerifiedAt(user.id, at);
      expect((await users.findById(user.id))?.emailVerifiedAt?.toISOString()).toBe(at.toISOString());
      await users.setEmailVerifiedAt(user.id, null);
      expect((await users.findById(user.id))?.emailVerifiedAt).toBeNull();
    });
  });
});
