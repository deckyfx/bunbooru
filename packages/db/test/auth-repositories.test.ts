import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createDb,
  createSessionRepository,
  createUserRepository,
  type DB,
  type SessionRepository,
  type UserRepository,
} from "../src/index";

/**
 * Integration tests against a real Postgres (opt-in `TEST_DATABASE_URL`) covering
 * the user + session repositories: unique constraints, the first-user bootstrap
 * count, valid-vs-expired session lookup, revocation, expiry GC, and the
 * `ON DELETE CASCADE` from users → sessions.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)("user + session repositories (integration)", () => {
  let db: DB;
  let users: UserRepository;
  let sessions: SessionRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    users = createUserRepository(db);
    sessions = createSessionRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE users, sessions RESTART IDENTITY CASCADE`);
  });

  async function seedUser(username: string, email: string | null = null) {
    return users.create({ username, email, passwordHash: `hash:${username}`, role: "member" });
  }

  describe("UserRepository", () => {
    it("creates, counts, and finds by username/id", async () => {
      expect(await users.countAll()).toBe(0);

      const created = await seedUser("alice", "alice@example.com");
      expect(created.id).toBeGreaterThan(0);
      expect(await users.countAll()).toBe(1);

      expect(await users.findByUsername("alice")).toMatchObject({ id: created.id });
      expect(await users.findById(created.id)).toMatchObject({ username: "alice" });
      expect(await users.findByUsername("nobody")).toBeNull();
      expect(await users.findById(999_999)).toBeNull();
    });

    it("allows multiple null emails but rejects duplicate usernames case-insensitively", async () => {
      await seedUser("alice", null);
      await seedUser("bob", null); // two NULL emails coexist under the unique index

      expect(await users.countAll()).toBe(2);

      // Canonical uniqueness: "Alice" collides with "alice" via the lower(username)
      // functional unique index. Bun's native SQL driver wraps the PG error under
      // `.cause`, exposing the SQLSTATE (23505) as `.cause.errno` — the contract
      // the auth service relies on to return 409 not 500.
      const error = await seedUser("Alice", null).catch((e: unknown) => e);
      const cause = (error as { cause?: { errno?: string; constraint?: string } }).cause;
      expect(cause?.errno).toBe("23505");
      expect(cause?.constraint).toBe("users_username_lower_idx");
    });

    it("createBootstrapping makes the first account admin and the rest members", async () => {
      const first = await users.createBootstrapping({
        username: "first",
        email: null,
        passwordHash: "h",
      });
      expect(first.role).toBe("admin");

      const second = await users.createBootstrapping({
        username: "second",
        email: null,
        passwordHash: "h",
      });
      expect(second.role).toBe("member");
    });
  });

  describe("SessionRepository", () => {
    async function openSession(username: string, expiresAt: Date) {
      const user = await seedUser(username);
      const tokenHash = new Bun.CryptoHasher("sha256").update(`token:${username}`).digest("hex");
      const session = await sessions.create({ userId: user.id, tokenHash, expiresAt });
      return { user, tokenHash, session };
    }

    it("finds a valid session but not an expired one", async () => {
      const now = new Date();
      const { tokenHash } = await openSession("alice", new Date(now.getTime() + HOUR));

      expect(await sessions.findValidByTokenHash(tokenHash, now)).not.toBeNull();

      // A `now` past the expiry reads as no session (logged-out) without a sweep.
      expect(await sessions.findValidByTokenHash(tokenHash, new Date(now.getTime() + 2 * HOUR))).toBeNull();
      // Unknown token → null.
      expect(await sessions.findValidByTokenHash("deadbeef", now)).toBeNull();
    });

    it("revokes a session by token hash", async () => {
      const now = new Date();
      const { tokenHash } = await openSession("alice", new Date(now.getTime() + HOUR));

      await sessions.deleteByTokenHash(tokenHash);
      expect(await sessions.findValidByTokenHash(tokenHash, now)).toBeNull();
      // Idempotent: deleting an already-gone session is a no-op.
      await sessions.deleteByTokenHash(tokenHash);
    });

    it("reclaims only expired sessions and reports the count", async () => {
      const now = new Date();
      await openSession("alice", new Date(now.getTime() - HOUR)); // expired
      await openSession("bob", new Date(now.getTime() - 2 * HOUR)); // expired
      const { tokenHash: liveHash } = await openSession("carol", new Date(now.getTime() + HOUR)); // live

      expect(await sessions.deleteExpired(now, 100)).toBe(2);
      expect(await sessions.findValidByTokenHash(liveHash, now)).not.toBeNull();
    });

    it("bounds a GC batch with the optional limit", async () => {
      const now = new Date();
      await openSession("alice", new Date(now.getTime() - HOUR));
      await openSession("bob", new Date(now.getTime() - 2 * HOUR));

      expect(await sessions.deleteExpired(now, 1)).toBe(1); // only one of the two
      expect(await sessions.deleteExpired(now, 1)).toBe(1); // the remaining one
      expect(await sessions.deleteExpired(now, 1)).toBe(0);
    });

    it("cascades: deleting a user removes its sessions", async () => {
      const now = new Date();
      const { user, tokenHash } = await openSession("alice", new Date(now.getTime() + HOUR));

      await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
      expect(await sessions.findValidByTokenHash(tokenHash, now)).toBeNull();
    });
  });
});
