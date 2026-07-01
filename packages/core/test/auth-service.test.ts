import { describe, expect, it } from "bun:test";

import type {
  ApiKey,
  ApiKeyRepository,
  Session,
  SessionRepository,
  User,
  UserRepository,
} from "@bunbooru/db";

import { AuthenticationError, RegistrationConflictError } from "../src/errors";
import { createAuthService } from "../src/services/auth-service";

/** In-memory {@link UserRepository}; `create` throws a PG-23505-shaped error on
 *  a duplicate username so the service's unique-violation mapping is exercised. */
function fakeUserRepo() {
  const rows: User[] = [];
  let nextId = 1;
  function insert(username: string, email: string | null, passwordHash: string, role: User["role"]): User {
    if (rows.some((r) => r.username === username)) {
      // Mirror how Bun's native SQL driver surfaces a unique violation: the
      // SQLSTATE is on `.cause.errno`, not the top-level `.code`.
      throw new Error("duplicate key", {
        cause: { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" },
      });
    }
    const user: User = {
      id: nextId++,
      username,
      email,
      passwordHash,
      role,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    rows.push(user);
    return user;
  }
  const repo: UserRepository = {
    create: async (input) => insert(input.username, input.email ?? null, input.passwordHash, input.role ?? "member"),
    // Atomic bootstrap: the first row is admin, the rest members.
    createBootstrapping: async (input) =>
      insert(input.username, input.email ?? null, input.passwordHash, rows.length === 0 ? "admin" : "member"),
    countAll: async () => rows.length,
    findByUsername: async (username) => rows.find((r) => r.username === username) ?? null,
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
  };
  return { repo, rows };
}

/** In-memory {@link SessionRepository}; `findValidByTokenHash` honours `now` so
 *  expiry can be driven deterministically. Keyed by token HASH, never the raw
 *  token — so a service that forgot to hash would fail to find/delete its rows. */
function fakeSessionRepo() {
  const rows: Session[] = [];
  let nextId = 1;
  const repo: SessionRepository = {
    create: async (input) => {
      const session: Session = {
        id: nextId++,
        tokenHash: input.tokenHash,
        userId: input.userId,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
      };
      rows.push(session);
      return session;
    },
    findValidByTokenHash: async (tokenHash, now) =>
      rows.find((r) => r.tokenHash === tokenHash && r.expiresAt.getTime() > now.getTime()) ?? null,
    deleteByTokenHash: async (tokenHash) => {
      const idx = rows.findIndex((r) => r.tokenHash === tokenHash);
      if (idx >= 0) rows.splice(idx, 1);
    },
    deleteExpired: async (now, limit) => {
      const expired = rows
        .filter((r) => r.expiresAt.getTime() < now.getTime())
        .slice(0, limit);
      for (const r of expired) rows.splice(rows.indexOf(r), 1);
      return expired.length;
    },
  };
  return { repo, rows };
}

/** In-memory {@link ApiKeyRepository}. Keyed by token HASH like the real one. */
function fakeApiKeyRepo() {
  const rows: ApiKey[] = [];
  let nextId = 1;
  const repo: ApiKeyRepository = {
    create: async (input) => {
      const key: ApiKey = {
        id: nextId++,
        tokenHash: input.tokenHash,
        userId: input.userId,
        name: input.name,
        lastUsedAt: input.lastUsedAt ?? null,
        createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
      };
      rows.push(key);
      return key;
    },
    findByTokenHash: async (tokenHash) => rows.find((r) => r.tokenHash === tokenHash) ?? null,
    listByUser: async (userId) => rows.filter((r) => r.userId === userId),
    deleteByIdForUser: async (id, userId) => {
      const idx = rows.findIndex((r) => r.id === id && r.userId === userId);
      if (idx < 0) return false;
      rows.splice(idx, 1);
      return true;
    },
    touchLastUsed: async (id, at) => {
      const key = rows.find((r) => r.id === id);
      if (key) key.lastUsedAt = at;
    },
  };
  return { repo, rows };
}

/** Assemble an auth service over the in-memory repos with a mutable clock. */
function makeService(sessionExpiryMs = 1000) {
  const users = fakeUserRepo();
  const sessions = fakeSessionRepo();
  const apiKeys = fakeApiKeyRepo();
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const service = createAuthService(users.repo, sessions.repo, apiKeys.repo, {
    sessionExpiryMs,
    now: () => clock,
  });
  return { service, users, sessions, apiKeys, setClock: (d: Date) => void (clock = d) };
}

describe("createAuthService.register", () => {
  it("makes the first account admin and the rest members, and lowercases usernames", async () => {
    const { service } = makeService();

    const first = await service.register({ username: "First", password: "supersecret" });
    expect(first.user.role).toBe("admin");
    expect(first.user.username).toBe("first");

    const second = await service.register({ username: "second", password: "supersecret" });
    expect(second.user.role).toBe("member");
  });

  it("stores a hash (never the plaintext) and opens a session resolvable by its token", async () => {
    const { service, users } = makeService();

    const { token, user } = await service.register({ username: "neo", password: "supersecret" });

    const stored = users.rows[0];
    expect(stored?.passwordHash).toBeString();
    expect(stored?.passwordHash).not.toBe("supersecret");
    expect(await Bun.password.verify("supersecret", stored?.passwordHash ?? "")).toBe(true);

    expect(await service.currentUser(token)).toMatchObject({ id: user.id, username: "neo" });
  });

  it("maps a unique-constraint violation to RegistrationConflictError", async () => {
    const { service } = makeService();
    await service.register({ username: "dup", password: "supersecret" });

    await expect(
      service.register({ username: "dup", password: "supersecret" }),
    ).rejects.toBeInstanceOf(RegistrationConflictError);
  });
});

describe("createAuthService.login", () => {
  it("rejects an unknown user and a wrong password, accepts correct (case-insensitive) creds", async () => {
    const { service } = makeService();
    await service.register({ username: "user", password: "supersecret" });

    await expect(service.login("ghost", "supersecret")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(service.login("user", "wrong-password")).rejects.toBeInstanceOf(
      AuthenticationError,
    );

    const { token, user } = await service.login("USER", "supersecret");
    expect(user.username).toBe("user");
    expect(await service.currentUser(token)).toMatchObject({ username: "user" });
  });
});

describe("createAuthService.currentUser", () => {
  it("resolves a valid session, null once expired, and null without a token", async () => {
    const { service, setClock } = makeService(1000);
    const { token } = await service.register({ username: "user", password: "supersecret" });

    expect(await service.currentUser(token)).not.toBeNull();

    setClock(new Date("2026-01-01T00:00:02.000Z")); // +2s, past the 1s expiry
    expect(await service.currentUser(token)).toBeNull();

    expect(await service.currentUser(null)).toBeNull();
    expect(await service.currentUser("")).toBeNull();
  });
});

describe("createAuthService.logout / gcExpiredSessions", () => {
  it("logout revokes the session by its hash so the token stops resolving", async () => {
    const { service, sessions } = makeService();
    const { token } = await service.register({ username: "user", password: "supersecret" });
    expect(sessions.rows).toHaveLength(1);

    // The repo is keyed by hash; that this deletes the row proves the service
    // hashed the raw token before deleting (a raw-token delete would miss).
    await service.logout(token);
    expect(sessions.rows).toHaveLength(0);
    expect(await service.currentUser(token)).toBeNull();
  });

  it("gcExpiredSessions reclaims expired sessions and reports the count", async () => {
    const { service, sessions, setClock } = makeService(1000);
    await service.register({ username: "user", password: "supersecret" });

    setClock(new Date("2026-01-01T00:00:02.000Z"));
    expect(await service.gcExpiredSessions()).toBe(1);
    expect(sessions.rows).toHaveLength(0);
  });
});

describe("createAuthService — API keys", () => {
  it("mints a `bnb_` key, stores only its hash, and resolves it via currentUser", async () => {
    const { service, apiKeys } = makeService();
    const { user } = await service.register({ username: "user", password: "supersecret" });

    const { key, record } = await service.createApiKey(user.id, "laptop");
    expect(key.startsWith("bnb_")).toBe(true);
    expect(record.name).toBe("laptop");
    // The DB row stores a hash, never the raw key.
    expect(apiKeys.rows[0]?.tokenHash).toBeString();
    expect(apiKeys.rows[0]?.tokenHash).not.toBe(key);

    // The raw key authenticates (no expiry — even far in the future).
    const resolved = await service.currentUser(key);
    expect(resolved).toMatchObject({ id: user.id, username: "user" });
  });

  it("does not resolve a bogus API key or a revoked one", async () => {
    const { service } = makeService();
    const { user } = await service.register({ username: "user", password: "supersecret" });
    const { key, record } = await service.createApiKey(user.id, "cli");

    expect(await service.currentUser("bnb_deadbeef")).toBeNull();

    // Revoke scoped to owner: another user can't revoke it, the owner can.
    expect(await service.revokeApiKey(user.id + 999, record.id)).toBe(false);
    expect(await service.currentUser(key)).not.toBeNull();
    expect(await service.revokeApiKey(user.id, record.id)).toBe(true);
    expect(await service.currentUser(key)).toBeNull();
  });

  it("lists a user's keys", async () => {
    const { service } = makeService();
    const { user } = await service.register({ username: "user", password: "supersecret" });
    await service.createApiKey(user.id, "a");
    await service.createApiKey(user.id, "b");

    const keys = await service.listApiKeys(user.id);
    expect(keys.map((k) => k.name).sort()).toEqual(["a", "b"]);
  });
});
