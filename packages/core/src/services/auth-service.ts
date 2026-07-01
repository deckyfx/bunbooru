import type { SessionRepository, User, UserRepository } from "@bunbooru/db";

import { AuthenticationError, RegistrationConflictError } from "../errors";

/** How many expired sessions one GC sweep reclaims per call. */
const SESSION_GC_BATCH = 1000;

/** New-account registration input (email optional). */
export interface RegisterInput {
  username: string;
  password: string;
  email?: string | null;
}

/** Result of register/login: the raw session token (shown once) + the user. */
export interface LoginResult {
  token: string;
  user: User;
}

/** A user safe to serialize over the wire — never includes the password hash. */
export type PublicUser = Omit<User, "passwordHash">;

/**
 * Accounts + login sessions. Registration hashes the password (Bun/Argon2id) and
 * opens a session; login verifies and opens one; a session is an opaque token
 * whose sha256 hash is all the DB keeps. Stays HTTP-agnostic — the API sets the
 * cookie / reads the `Authorization` header and maps the typed errors to codes.
 */
export interface AuthService {
  /** Register (first account becomes `admin`, rest `member`) and auto-log-in. */
  register(input: RegisterInput): Promise<LoginResult>;
  /** Verify credentials and open a session. Throws {@link AuthenticationError} on failure. */
  login(username: string, password: string): Promise<LoginResult>;
  /** Resolve the user for a raw session token (cookie or Bearer), or null. */
  currentUser(token: string | null | undefined): Promise<User | null>;
  /** Revoke a session by its raw token (logout). */
  logout(token: string): Promise<void>;
  /** Reclaim expired sessions; returns how many were removed. */
  gcExpiredSessions(at?: Date): Promise<number>;
}

/** Configuration for {@link createAuthService}. */
export interface AuthServiceConfig {
  /** Session lifetime in milliseconds. */
  sessionExpiryMs: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/** Normalize a username for storage + lookup (usernames are case-insensitive). */
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** sha256 hex of a value — how session tokens are stored/looked up. */
function sha256hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** A fresh, high-entropy opaque session token (256 bits → 64 hex chars). */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Walk the error's cause chain for a Postgres unique-violation. The SQLSTATE
 * lives in different fields per driver: node-postgres exposes it as `.code`,
 * while Bun's native SQL driver puts it in `.errno` (with `.code` set to the
 * generic `"ERR_POSTGRES_SERVER_ERROR"`) and wraps the real error under `.cause`.
 * Accept either field, at any depth.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e !== null && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const record = e as { code?: unknown; errno?: unknown };
    if (record.code === PG_UNIQUE_VIOLATION || record.errno === PG_UNIQUE_VIOLATION) return true;
  }
  return false;
}

/**
 * Build an {@link AuthService}. `now` is injectable so tests can drive session
 * expiry deterministically.
 */
export function createAuthService(
  users: UserRepository,
  sessions: SessionRepository,
  { sessionExpiryMs, now = () => new Date() }: AuthServiceConfig,
): AuthService {
  // Lazily-built Argon2 hash used to keep login timing constant for unknown
  // usernames (so response time can't be used to enumerate accounts).
  let dummyHash: string | null = null;
  async function timingSafeReject(password: string): Promise<void> {
    dummyHash ??= await Bun.password.hash("bunbooru-timing-safety-dummy");
    await Bun.password.verify(password, dummyHash).catch(() => undefined);
  }

  async function openSession(userId: number): Promise<string> {
    const token = generateToken();
    await sessions.create({
      userId,
      tokenHash: sha256hex(token),
      expiresAt: new Date(now().getTime() + sessionExpiryMs),
    });
    return token;
  }

  return {
    async register({ username, password, email }) {
      const normalized = normalizeUsername(username);
      const passwordHash = await Bun.password.hash(password);

      // The repository assigns the bootstrap role atomically (first account →
      // admin) under an advisory lock, so concurrent first-registrations can't
      // both become admin.
      let user: User;
      try {
        user = await users.createBootstrapping({
          username: normalized,
          email: email ?? null,
          passwordHash,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new RegistrationConflictError();
        throw error;
      }

      const token = await openSession(user.id);
      return { token, user };
    },

    async login(username, password) {
      const user = await users.findByUsername(normalizeUsername(username));
      if (!user) {
        await timingSafeReject(password);
        throw new AuthenticationError("Invalid username or password");
      }
      if (!(await Bun.password.verify(password, user.passwordHash))) {
        throw new AuthenticationError("Invalid username or password");
      }
      const token = await openSession(user.id);
      return { token, user };
    },

    async currentUser(token) {
      if (!token) return null;
      const session = await sessions.findValidByTokenHash(sha256hex(token), now());
      if (!session) return null;
      return users.findById(session.userId);
    },

    async logout(token) {
      await sessions.deleteByTokenHash(sha256hex(token));
    },

    gcExpiredSessions(at = now()) {
      return sessions.deleteExpired(at, SESSION_GC_BATCH);
    },
  };
}
