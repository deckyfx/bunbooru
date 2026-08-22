import type {
  ApiKey,
  ApiKeyRepository,
  AuthTokenRepository,
  SessionRepository,
  User,
  UserRepository,
} from "@bunbooru/db";

import { AuthenticationError, RegistrationConflictError, ValidationError } from "../errors";
import { renderEmailVerificationMail, renderPasswordResetMail } from "../mail/auth-mail";
import type { MailService } from "../mail/mail-service";

/** How many expired sessions one GC sweep reclaims per call. */
const SESSION_GC_BATCH = 1000;

/** How many expired auth tokens one GC sweep reclaims per call. */
const AUTH_TOKEN_GC_BATCH = 1000;

/**
 * Minimum password length — the SINGLE source of truth shared by registration,
 * self-serve reset/change, and the admin CLI (rather than a copy per call site).
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Default lifetime of a reset / verify token (30 min — short but mail-delay tolerant). */
const DEFAULT_AUTH_TOKEN_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Prefix distinguishing a long-lived API key from a session token. Session
 * tokens are bare 64-hex; API keys are `bnb_<64hex>`, so `currentUser` can
 * dispatch on the prefix without a schema change.
 */
const API_KEY_PREFIX = "bnb_";

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

/** An API key without its secret hash — safe to hand outside the auth service. */
export type ApiKeySummary = Omit<ApiKey, "tokenHash">;

/** Drop the secret `tokenHash` so it never leaks into a response or log. */
function toApiKeySummary({ id, userId, name, lastUsedAt, createdAt }: ApiKey): ApiKeySummary {
  return { id, userId, name, lastUsedAt, createdAt };
}

/** Result of minting an API key: the raw key (shown once) + the summary row. */
export interface CreatedApiKey {
  key: string;
  record: ApiKeySummary;
}

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
  /**
   * Resolve the user for a raw credential — a session token (cookie/Bearer) OR a
   * `bnb_…` API key — or null. Dispatches on the API-key prefix.
   */
  currentUser(token: string | null | undefined): Promise<User | null>;
  /** Revoke a session by its raw token (logout). */
  logout(token: string): Promise<void>;
  /** Reclaim expired sessions; returns how many were removed. */
  gcExpiredSessions(at?: Date): Promise<number>;
  /** Mint a named API key for a user; the raw key is returned only here. */
  createApiKey(userId: number, name: string): Promise<CreatedApiKey>;
  /** A user's API keys (no raw tokens or hashes), newest first. */
  listApiKeys(userId: number): Promise<ApiKeySummary[]>;
  /** Revoke one of the user's API keys; true if a key was removed. */
  revokeApiKey(userId: number, id: number): Promise<boolean>;
  /**
   * Look up a user by username (case-insensitive), or null. Returns the
   * public projection (never the password hash) — used e.g. by the importer to
   * resolve/validate a target user before attributing imported posts to them.
   */
  findByUsername(username: string): Promise<PublicUser | null>;
  /**
   * Begin self-serve password reset for `email`. ALWAYS resolves the same way
   * whether or not the address exists (no account-enumeration oracle): a real,
   * eligible account is emailed a single-use link; anything else is a silent
   * no-op. When `require_verified_email_for_reset` is on, an unverified address
   * is treated as ineligible. Requires a configured mail provider (the API
   * pre-checks and 503s otherwise).
   */
  requestPasswordReset(input: { email: string; ip?: string | null }): Promise<void>;
  /**
   * Redeem a reset token: rewrite the password and revoke ALL the user's
   * sessions, atomically. Throws {@link ValidationError} for a too-short password
   * and {@link AuthenticationError} for an invalid/expired/used token.
   */
  resetPassword(token: string, password: string): Promise<void>;
  /**
   * Change a logged-in user's password after verifying the current one. Revokes
   * all existing sessions (a change is also a compromise remedy) and returns a
   * FRESH session so the caller stays logged in. Throws {@link AuthenticationError}
   * on a wrong current password and {@link ValidationError} for a too-short new one.
   */
  changePassword(userId: number, currentPassword: string, newPassword: string): Promise<LoginResult>;
  /**
   * Email the logged-in user a verification link for the address on their
   * account. Throws {@link ValidationError} if the account has no email; a no-op
   * if it's already verified. Requires a configured mail provider.
   */
  requestEmailVerification(input: { userId: number; ip?: string | null }): Promise<void>;
  /**
   * Redeem a verification token, stamping the account's email as verified. Throws
   * {@link AuthenticationError} for an invalid/expired/used token.
   */
  confirmEmailVerification(token: string): Promise<void>;
  /** Reclaim expired reset/verify tokens; returns how many were removed. */
  gcExpiredTokens(at?: Date): Promise<number>;
}

/** Configuration for {@link createAuthService}. */
export interface AuthServiceConfig {
  /** Session lifetime in milliseconds. */
  sessionExpiryMs: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * Absolute public base URL used to build the links in reset/verify emails
   * (no trailing slash). NEVER derived from the request `Host` header (that's the
   * classic host-header reset vulnerability). Null when unset — reset/verify
   * requests then become silent no-ops (the composition root guarantees it's set
   * whenever a mail provider is active).
   */
  publicBaseUrl: string | null;
  /** Reset/verify token TTL in ms. Defaults to {@link DEFAULT_AUTH_TOKEN_EXPIRY_MS}. */
  authTokenExpiryMs?: number;
  /**
   * Reads the runtime `require_verified_email_for_reset` policy. Injected as a
   * getter (not a boolean) so an admin toggle takes effect without rebuilding the
   * service.
   */
  resetRequiresVerifiedEmail: () => Promise<boolean>;
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

/**
 * A fresh reset/verify token: 32 random bytes (256 bits), base64url-encoded so it
 * travels safely in a URL query parameter. Only its sha256 hash is stored.
 */
function generateAuthToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
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
  apiKeys: ApiKeyRepository,
  authTokens: AuthTokenRepository,
  mail: MailService,
  {
    sessionExpiryMs,
    now = () => new Date(),
    publicBaseUrl,
    authTokenExpiryMs = DEFAULT_AUTH_TOKEN_EXPIRY_MS,
    resetRequiresVerifiedEmail,
  }: AuthServiceConfig,
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

  /** Reject a password that doesn't meet the shared minimum length. */
  function assertPasswordLength(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  /**
   * Mint a purposed token for `user`, invalidating any outstanding ones of the
   * same purpose first, and email `render`ed message with the link. Returns the
   * raw token (for logging-free tests); errors from the mail send are logged-and-
   * swallowed by the caller where enumeration-safety demands it.
   */
  async function issueAuthTokenAndSend(
    user: User,
    purpose: "password-reset" | "verify-email",
    ip: string | null | undefined,
    path: string,
    render: (link: string, expiryMinutes: number) => { subject: string; text: string },
  ): Promise<void> {
    if (!user.email || !publicBaseUrl) return; // nothing to send to / nowhere to link
    const at = now();
    await authTokens.invalidateOutstanding(user.id, purpose, at);
    const rawToken = generateAuthToken();
    const row = await authTokens.create({
      userId: user.id,
      purpose,
      tokenHash: sha256hex(rawToken),
      expiresAt: new Date(at.getTime() + authTokenExpiryMs),
      requestedIp: ip ?? null,
    });
    const link = `${publicBaseUrl}${path}?token=${encodeURIComponent(rawToken)}`;
    const { subject, text } = render(link, Math.round(authTokenExpiryMs / 60000));
    await mail.send({
      to: user.email,
      subject,
      text,
      idempotencyKey: `${purpose}:${row.id}`,
    });
  }

  return {
    async register({ username, password, email }) {
      assertPasswordLength(password);
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

      // API key (`bnb_…`): no expiry, valid until revoked.
      if (token.startsWith(API_KEY_PREFIX)) {
        const key = await apiKeys.findByTokenHash(sha256hex(token));
        if (!key) return null;
        // Best-effort activity timestamp; never let it fail the request.
        void apiKeys.touchLastUsed(key.id, now()).catch(() => undefined);
        return users.findById(key.userId);
      }

      // Session token.
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

    async createApiKey(userId, name) {
      const key = API_KEY_PREFIX + generateToken();
      const record = await apiKeys.create({ userId, name, tokenHash: sha256hex(key) });
      return { key, record: toApiKeySummary(record) };
    },

    async listApiKeys(userId) {
      return (await apiKeys.listByUser(userId)).map(toApiKeySummary);
    },

    revokeApiKey(userId, id) {
      return apiKeys.deleteByIdForUser(id, userId);
    },

    async findByUsername(username) {
      const user = await users.findByUsername(normalizeUsername(username));
      if (!user) return null;
      // Strip the password hash — callers only ever need the public projection.
      const { passwordHash: _passwordHash, ...publicUser } = user;
      return publicUser;
    },

    async requestPasswordReset({ email, ip }) {
      const normalized = email.trim();
      // Timing parity against enumeration is best-effort: the DB write + mail send
      // only happen for a real, eligible account, so the response time already
      // differs. We don't fake a token here — a single discarded generate() is
      // negligible next to that DB+mail cost and wouldn't actually equalize it.
      if (!normalized) return;

      const user = await users.findByEmail(normalized);
      if (!user) return;

      // Eligibility: when the policy requires it, an unverified address can't
      // reset (an unverified address is not a proven credential). Never reveal
      // this distinction to the caller — the endpoint's response is identical.
      if ((await resetRequiresVerifiedEmail()) && !user.emailVerifiedAt) return;

      try {
        await issueAuthTokenAndSend(user, "password-reset", ip, "/reset-password", renderPasswordResetMail);
      } catch {
        // Swallow send/persistence errors: surfacing them would turn the endpoint
        // into an enumeration/oracle. The provider (outbox) logs its own failures.
      }
    },

    async resetPassword(token, password) {
      assertPasswordLength(password);
      const tokenHash = sha256hex(token);
      // Cheap pre-check: reject an unknown / wrong-purpose / consumed / expired
      // token BEFORE paying for the (deliberately expensive) Argon2 hash, so an
      // invalid link can't be used to burn CPU. `consumeForPasswordReset` remains
      // the atomic single-use authority below — it re-checks under the row lock,
      // closing any race between this read and the consume.
      const existing = await authTokens.findByHash(tokenHash);
      if (
        !existing ||
        existing.purpose !== "password-reset" ||
        existing.consumedAt !== null ||
        existing.expiresAt <= now()
      ) {
        throw new AuthenticationError("This reset link is invalid or has expired");
      }
      const newPasswordHash = await Bun.password.hash(password);
      const userId = await authTokens.consumeForPasswordReset({
        tokenHash,
        now: now(),
        newPasswordHash,
      });
      if (userId === null) {
        throw new AuthenticationError("This reset link is invalid or has expired");
      }
    },

    async changePassword(userId, currentPassword, newPassword) {
      assertPasswordLength(newPassword);
      const user = await users.findById(userId);
      if (!user) throw new AuthenticationError();
      if (!(await Bun.password.verify(currentPassword, user.passwordHash))) {
        throw new AuthenticationError("Current password is incorrect");
      }
      const newPasswordHash = await Bun.password.hash(newPassword);
      await users.setPasswordHash(user.id, newPasswordHash);
      // Revoke every session (a change is also a compromise remedy), then open a
      // fresh one so the caller's browser stays logged in.
      await sessions.deleteAllForUser(user.id);
      const token = await openSession(user.id);
      // Return the user with the NEW hash — not the stale row loaded above.
      return { token, user: { ...user, passwordHash: newPasswordHash } };
    },

    async requestEmailVerification({ userId, ip }) {
      const user = await users.findById(userId);
      if (!user) throw new AuthenticationError();
      if (!user.email) throw new ValidationError("Your account has no email address to verify");
      if (user.emailVerifiedAt) return; // already verified — nothing to do
      await issueAuthTokenAndSend(user, "verify-email", ip, "/verify-email", renderEmailVerificationMail);
    },

    async confirmEmailVerification(token) {
      const at = now();
      const userId = await authTokens.consumeForEmailVerification({
        tokenHash: sha256hex(token),
        now: at,
        verifiedAt: at,
      });
      if (userId === null) {
        throw new AuthenticationError("This verification link is invalid or has expired");
      }
    },

    gcExpiredTokens(at = now()) {
      return authTokens.deleteExpired(at, AUTH_TOKEN_GC_BATCH);
    },
  };
}
