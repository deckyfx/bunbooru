import { describe, expect, it } from "bun:test";

import type {
  ApiKey,
  ApiKeyRepository,
  AuthToken,
  AuthTokenPurpose,
  AuthTokenRepository,
  NewAuthToken,
  Session,
  SessionRepository,
  User,
  UserRepository,
} from "@bunbooru/db";

import { AuthenticationError, RegistrationConflictError, ValidationError } from "../src/errors";
import { createMailService, type MailService } from "../src/mail/mail-service";
import type { OutgoingMail } from "../src/mail/mail-provider";
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
      emailVerifiedAt: null,
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
    findByEmail: async (email) =>
      rows.find((r) => r.email !== null && r.email.toLowerCase() === email.toLowerCase()) ?? null,
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    setPasswordHash: async (id, passwordHash) => {
      const user = rows.find((r) => r.id === id);
      if (user) user.passwordHash = passwordHash;
    },
    setEmail: async (id, email) => {
      const user = rows.find((r) => r.id === id);
      if (user) {
        // Mirror the real repo: a case-insensitive clash is a unique violation.
        if (email !== null && rows.some((r) => r.id !== id && r.email?.toLowerCase() === email.toLowerCase())) {
          throw Object.assign(new Error("duplicate"), { code: "23505" });
        }
        user.email = email;
        user.emailVerifiedAt = null;
      }
    },
    setEmailVerifiedAt: async (id, at) => {
      const user = rows.find((r) => r.id === id);
      if (user) user.emailVerifiedAt = at;
    },
    resetCredentials: async (id, { passwordHash, email }) => {
      const user = rows.find((r) => r.id === id);
      if (!user) return;
      // Atomic mirror: a case-insensitive email clash rejects the WHOLE update, so
      // the password stays unchanged (validate before mutating either column).
      if (email !== undefined && rows.some((r) => r.id !== id && r.email?.toLowerCase() === email.toLowerCase())) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      user.passwordHash = passwordHash;
      if (email !== undefined) {
        user.email = email;
        user.emailVerifiedAt = null;
      }
    },
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
    deleteAllForUser: async (userId) => {
      const removed = rows.filter((r) => r.userId === userId);
      for (const r of removed) rows.splice(rows.indexOf(r), 1);
      return removed.length;
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

/**
 * In-memory {@link AuthTokenRepository}. The `consumeFor…` methods reach into the
 * shared user + session fakes so single-use, password-rewrite, and session-
 * revocation are all observable — exactly the atomic effect the real repo's
 * transaction provides.
 */
function fakeAuthTokenRepo(
  users: ReturnType<typeof fakeUserRepo>,
  sessions: ReturnType<typeof fakeSessionRepo>,
) {
  const rows: AuthToken[] = [];
  let nextId = 1;

  function consume(tokenHash: string, purpose: AuthTokenPurpose, now: Date): AuthToken | null {
    const row = rows.find(
      (r) =>
        r.tokenHash === tokenHash &&
        r.purpose === purpose &&
        r.consumedAt === null &&
        r.expiresAt.getTime() > now.getTime(),
    );
    if (!row) return null;
    row.consumedAt = now;
    return row;
  }

  const repo: AuthTokenRepository = {
    create: async (input: NewAuthToken) => {
      const row: AuthToken = {
        id: nextId++,
        userId: input.userId,
        purpose: input.purpose,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        consumedAt: input.consumedAt ?? null,
        createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
        requestedIp: input.requestedIp ?? null,
      };
      rows.push(row);
      return row;
    },
    findByHash: async (tokenHash) => rows.find((r) => r.tokenHash === tokenHash) ?? null,
    invalidateOutstanding: async (userId, purpose, at) => {
      for (const r of rows) {
        if (r.userId === userId && r.purpose === purpose && r.consumedAt === null) r.consumedAt = at;
      }
    },
    deleteExpired: async (now, limit) => {
      const expired = rows.filter((r) => r.expiresAt.getTime() <= now.getTime()).slice(0, limit);
      for (const r of expired) rows.splice(rows.indexOf(r), 1);
      return expired.length;
    },
    consumeForPasswordReset: async ({ tokenHash, now, newPasswordHash }) => {
      const row = consume(tokenHash, "password-reset", now);
      if (!row) return null;
      await users.repo.setPasswordHash(row.userId, newPasswordHash);
      await sessions.repo.deleteAllForUser(row.userId);
      return row.userId;
    },
    consumeForEmailVerification: async ({ tokenHash, now, verifiedAt }) => {
      const row = consume(tokenHash, "verify-email", now);
      if (!row) return null;
      await users.repo.setEmailVerifiedAt(row.userId, verifiedAt);
      return row.userId;
    },
  };
  return { repo, rows };
}

/** A {@link MailService} that records every message it's asked to send. */
function collectingMail() {
  const sent: OutgoingMail[] = [];
  const service = createMailService();
  service.setProvider(
    {
      send: async (mail) => void sent.push(mail),
      verify: async () => undefined,
    },
    "test-mailer",
  );
  return { service, sent };
}

/** Options for {@link makeService}. */
interface MakeServiceOptions {
  sessionExpiryMs?: number;
  authTokenExpiryMs?: number;
  publicBaseUrl?: string | null;
  requireVerifiedEmail?: boolean;
  mail?: MailService;
}

/** Assemble an auth service over the in-memory repos with a mutable clock. */
function makeService(options: MakeServiceOptions = {}) {
  const {
    sessionExpiryMs = 1000,
    authTokenExpiryMs = 30 * 60 * 1000,
    publicBaseUrl = "https://booru.test",
    requireVerifiedEmail = false,
    mail,
  } = options;
  const users = fakeUserRepo();
  const sessions = fakeSessionRepo();
  const apiKeys = fakeApiKeyRepo();
  const authTokens = fakeAuthTokenRepo(users, sessions);
  const mailService = mail ?? collectingMail().service;
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const service = createAuthService(users.repo, sessions.repo, apiKeys.repo, authTokens.repo, mailService, {
    sessionExpiryMs,
    authTokenExpiryMs,
    publicBaseUrl,
    now: () => clock,
    resetRequiresVerifiedEmail: async () => requireVerifiedEmail,
  });
  return {
    service,
    users,
    sessions,
    apiKeys,
    authTokens,
    setClock: (d: Date) => void (clock = d),
  };
}

/** {@link makeService} wired to a message-collecting mail service; exposes `sent`. */
function collectMailService(options: Omit<MakeServiceOptions, "mail"> = {}) {
  const { service: mail, sent } = collectingMail();
  return { ...makeService({ ...options, mail }), sent };
}

/** Extract the raw `?token=` value from a rendered mail body's link. */
function tokenFromMail(mail: OutgoingMail): string {
  const match = /https?:\/\/\S+/.exec(mail.text);
  return match ? (new URL(match[0]).searchParams.get("token") ?? "") : "";
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

describe("createAuthService.findByUsername", () => {
  it("resolves a user case-insensitively, without the password hash", async () => {
    const { service } = makeService();
    const { user } = await service.register({ username: "Alice", password: "supersecret" });

    const found = await service.findByUsername("ALICE");
    expect(found?.id).toBe(user.id);
    expect(found?.username).toBe("alice");
    // PublicUser projection — the hash must never be exposed.
    expect(found !== null && "passwordHash" in found).toBe(false);
  });

  it("returns null for an unknown user", async () => {
    const { service } = makeService();
    expect(await service.findByUsername("nobody")).toBeNull();
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
    const { service, setClock } = makeService({ sessionExpiryMs: 1000 });
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
    const { service, sessions, setClock } = makeService({ sessionExpiryMs: 1000 });
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

describe("createAuthService.requestPasswordReset", () => {
  it("emails a single-use reset link for a real address (token stored only as a hash)", async () => {
    const { service, sent } = collectMailService();
    await service.register({ username: "alice", password: "supersecret", email: "alice@example.com" });

    await service.requestPasswordReset({ email: "ALICE@example.com" }); // case-insensitive

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe("alice@example.com");
    // The link carries the raw token; a token row exists but stores only a hash.
    const url = new URL(/https:\/\/\S+/.exec(mail.text)?.[0] ?? "");
    const rawToken = url.searchParams.get("token");
    expect(rawToken).toBeTruthy();
    expect(url.pathname).toBe("/reset-password");
  });

  it("is a silent no-op for an unknown address (no enumeration, no throw, no mail)", async () => {
    const { service, sent } = collectMailService();
    await service.register({ username: "alice", password: "supersecret", email: "alice@example.com" });

    await service.requestPasswordReset({ email: "nobody@example.com" });
    expect(sent).toHaveLength(0);
  });

  it("refuses an unverified address only when the policy requires verification", async () => {
    // Policy on + unverified → no mail.
    const off = collectMailService({ requireVerifiedEmail: true });
    await off.service.register({ username: "a", password: "supersecret", email: "a@example.com" });
    await off.service.requestPasswordReset({ email: "a@example.com" });
    expect(off.sent).toHaveLength(0);

    // Policy off → mail sent even though unverified.
    const on = collectMailService({ requireVerifiedEmail: false });
    await on.service.register({ username: "b", password: "supersecret", email: "b@example.com" });
    await on.service.requestPasswordReset({ email: "b@example.com" });
    expect(on.sent).toHaveLength(1);
  });

  it("invalidates a prior outstanding reset token when a new one is requested", async () => {
    const { service, sent, authTokens } = collectMailService();
    await service.register({ username: "alice", password: "supersecret", email: "alice@example.com" });

    await service.requestPasswordReset({ email: "alice@example.com" });
    await service.requestPasswordReset({ email: "alice@example.com" });

    // Two tokens exist; the first is already consumed (invalidated).
    const resetTokens = authTokens.rows.filter((r) => r.purpose === "password-reset");
    expect(resetTokens).toHaveLength(2);
    expect(resetTokens[0]?.consumedAt).not.toBeNull();

    // The first link no longer works; the newest one does.
    const firstToken = tokenFromMail(sent[0]!);
    const secondToken = tokenFromMail(sent[1]!);
    await expect(service.resetPassword(firstToken, "newsupersecret")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await service.resetPassword(secondToken, "newsupersecret");
  });
});

describe("createAuthService.resetPassword", () => {
  it("rewrites the password, revokes all sessions, and is single-use", async () => {
    const { service, sent, sessions } = collectMailService();
    const { token: sessionToken } = await service.register({
      username: "alice",
      password: "supersecret",
      email: "alice@example.com",
    });
    expect(sessions.rows).toHaveLength(1);

    await service.requestPasswordReset({ email: "alice@example.com" });
    const rawToken = tokenFromMail(sent[0]!);

    await service.resetPassword(rawToken, "brand-new-pass");

    // Old session revoked; old password rejected; new password works.
    expect(await service.currentUser(sessionToken)).toBeNull();
    await expect(service.login("alice", "supersecret")).rejects.toBeInstanceOf(AuthenticationError);
    const relogin = await service.login("alice", "brand-new-pass");
    expect(relogin.user.username).toBe("alice");

    // The token can't be redeemed twice.
    await expect(service.resetPassword(rawToken, "another-pass-1")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects an expired token", async () => {
    const { service, sent, setClock } = collectMailService({ authTokenExpiryMs: 1000 });
    await service.register({ username: "alice", password: "supersecret", email: "alice@example.com" });
    await service.requestPasswordReset({ email: "alice@example.com" });
    const rawToken = tokenFromMail(sent[0]!);

    setClock(new Date("2026-01-01T00:00:02.000Z")); // +2s, past the 1s TTL
    await expect(service.resetPassword(rawToken, "brand-new-pass")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects a too-short password before touching the token", async () => {
    const { service } = collectMailService();
    await expect(service.resetPassword("whatever", "short")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("createAuthService.changePassword", () => {
  it("verifies the current password, revokes old sessions, and returns a fresh one", async () => {
    const { service, sessions } = makeService();
    const { user, token: oldToken } = await service.register({
      username: "alice",
      password: "supersecret",
    });

    await expect(service.changePassword(user.id, "wrong", "new-password")).rejects.toBeInstanceOf(
      AuthenticationError,
    );

    const { token: newToken } = await service.changePassword(user.id, "supersecret", "new-password");
    // Old session gone, fresh one valid, exactly one session row.
    expect(await service.currentUser(oldToken)).toBeNull();
    expect(await service.currentUser(newToken)).toMatchObject({ id: user.id });
    expect(sessions.rows).toHaveLength(1);
    // New password authenticates.
    expect((await service.login("alice", "new-password")).user.id).toBe(user.id);
  });

  it("rejects a too-short new password", async () => {
    const { service } = makeService();
    const { user } = await service.register({ username: "alice", password: "supersecret" });
    await expect(service.changePassword(user.id, "supersecret", "short")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("createAuthService.changeEmail", () => {
  it("requires the current password and sets the new (unverified) email", async () => {
    const { service } = makeService();
    const { user } = await service.register({ username: "alice", password: "supersecret" });

    await expect(service.changeEmail(user.id, "wrong", "new@example.com")).rejects.toBeInstanceOf(
      AuthenticationError,
    );

    const updated = await service.changeEmail(user.id, "supersecret", "new@example.com");
    expect(updated.email).toBe("new@example.com");
    expect(updated.emailVerifiedAt).toBeNull();
    expect(updated).not.toHaveProperty("passwordHash");
  });

  it("rejects an empty email", async () => {
    const { service } = makeService();
    const { user } = await service.register({ username: "alice", password: "supersecret" });
    await expect(service.changeEmail(user.id, "supersecret", "  ")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects an email already in use (case-insensitive)", async () => {
    const { service } = makeService();
    await service.register({ username: "bob", password: "supersecret", email: "taken@example.com" });
    const { user } = await service.register({ username: "alice", password: "supersecret" });
    await expect(
      service.changeEmail(user.id, "supersecret", "TAKEN@example.com"),
    ).rejects.toBeInstanceOf(RegistrationConflictError);
  });

  it("preserves verification when the submitted address is unchanged (case-insensitive)", async () => {
    const { service, users } = makeService();
    const { user } = await service.register({
      username: "alice",
      password: "supersecret",
      email: "alice@example.com",
    });
    // Prove the address, then re-submit it in a different case — a no-op that must
    // NOT clear the verified stamp (which would also block a verified-email reset).
    users.rows[0]!.emailVerifiedAt = new Date();

    const result = await service.changeEmail(user.id, "supersecret", "ALICE@example.com");
    expect(result.email).toBe("alice@example.com");
    expect(result.emailVerifiedAt).not.toBeNull();
    expect(users.rows[0]?.emailVerifiedAt).not.toBeNull();
  });
});

describe("createAuthService — email verification", () => {
  it("emails a verify link and confirming stamps email_verified_at", async () => {
    const { service, sent, users } = collectMailService();
    const { user } = await service.register({
      username: "alice",
      password: "supersecret",
      email: "alice@example.com",
    });

    await service.requestEmailVerification({ userId: user.id });
    expect(sent).toHaveLength(1);
    expect(new URL(/https:\/\/\S+/.exec(sent[0]!.text)?.[0] ?? "").pathname).toBe("/verify-email");

    const rawToken = tokenFromMail(sent[0]!);
    await service.confirmEmailVerification(rawToken);
    expect(users.rows[0]?.emailVerifiedAt).not.toBeNull();

    // Single-use.
    await expect(service.confirmEmailVerification(rawToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects verification for an account with no email", async () => {
    const { service } = collectMailService();
    const { user } = await service.register({ username: "alice", password: "supersecret" });
    await expect(service.requestEmailVerification({ userId: user.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("createAuthService.gcExpiredTokens", () => {
  it("reclaims expired tokens and reports the count", async () => {
    const { service, sent, setClock } = collectMailService({ authTokenExpiryMs: 1000 });
    await service.register({ username: "alice", password: "supersecret", email: "alice@example.com" });
    await service.requestPasswordReset({ email: "alice@example.com" });
    expect(sent).toHaveLength(1);

    setClock(new Date("2026-01-01T00:00:02.000Z"));
    expect(await service.gcExpiredTokens()).toBe(1);
  });
});
