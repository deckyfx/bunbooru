import { eq, sql } from "drizzle-orm";

import { users, type NewUser, type User } from "../schema";
import type { DB } from "../client";

/**
 * Advisory-lock key that serializes the first-user (admin) bootstrap. Arbitrary
 * but stable so every concurrent registration contends on the same lock.
 */
const USERS_BOOTSTRAP_LOCK = 987_654_321;

/**
 * Data access for {@link User} rows (the sole SQL layer per CLAUDE.md). Usernames
 * are canonicalized to lowercase HERE on EVERY write path — matching the
 * `lower(username)` unique index — so identity is case-insensitive regardless of
 * how a caller cases the input: both `create` and `createBootstrapping` store the
 * lowercased form, and `findByUsername` matches on `lower(username)`.
 */
export interface UserRepository {
  /**
   * Insert one user with an explicit role, returning the persisted row. The
   * username is stored canonicalized (lowercase), like `createBootstrapping`.
   */
  create(input: NewUser): Promise<User>;
  /**
   * Register a user, assigning the bootstrap role ATOMICALLY: the very first
   * account becomes `admin`, every other `member`. The count→insert runs inside
   * a transaction holding an advisory lock, so two concurrent
   * first-registrations can't both observe an empty table and both win admin.
   */
  createBootstrapping(input: Omit<NewUser, "role">): Promise<User>;
  /** Total number of accounts. */
  countAll(): Promise<number>;
  /** One user by username, matched case-insensitively (canonical lowercase). */
  findByUsername(username: string): Promise<User | null>;
  /**
   * One user by email, matched case-insensitively, or null. Emails are stored
   * verbatim but compared lower-cased so a differently-cased address still
   * resolves the same account (used by password-reset lookup).
   */
  findByEmail(email: string): Promise<User | null>;
  /** One user by id, or null. */
  findById(id: number): Promise<User | null>;
  /** Overwrite a user's password hash (self-serve reset / change-password). */
  setPasswordHash(id: number, passwordHash: string): Promise<void>;
  /**
   * Set (or clear with `null`) a user's email, resetting `emailVerifiedAt` to
   * NULL — a changed address is unproven until re-verified. Uniqueness is enforced
   * by the `lower(email)` index; a conflict surfaces as a unique violation.
   */
  setEmail(id: number, email: string | null): Promise<void>;
  /** Stamp (or clear) when the account's email was proven controlled. */
  setEmailVerifiedAt(id: number, at: Date | null): Promise<void>;
}

/** Build a {@link UserRepository} over a {@link DB} handle. */
export function createUserRepository(db: DB): UserRepository {
  return {
    async create(input) {
      const [row] = await db
        .insert(users)
        // Canonicalize the username (lowercase) so the stored value always
        // matches the lower(username) unique index, like createBootstrapping.
        .values({ ...input, username: input.username.toLowerCase() })
        .returning();
      if (!row) {
        throw new Error("user insert returned no row");
      }
      return row;
    },

    async createBootstrapping(input) {
      return db.transaction(async (tx) => {
        // Serialize the "is this the first account?" decision across concurrent
        // registrations; the lock releases when the transaction commits.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${USERS_BOOTSTRAP_LOCK})`);
        const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
        const role = (counted?.n ?? 0) === 0 ? "admin" : "member";
        const [row] = await tx
          .insert(users)
          // Store the canonical (lowercase) username so the stored value always
          // matches the lower(username) unique index, independent of caller casing.
          .values({ ...input, username: input.username.toLowerCase(), role })
          .returning();
        if (!row) {
          throw new Error("user insert returned no row");
        }
        return row;
      });
    },

    countAll() {
      return db.$count(users);
    },

    async findByUsername(username) {
      // Match on lower(username) so a differently-cased lookup still resolves the
      // canonical row (and the query can use the lower(username) unique index).
      const [row] = await db
        .select()
        .from(users)
        .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
        .limit(1);
      return row ?? null;
    },

    async findByEmail(email) {
      // Match on lower(email) so a differently-cased address resolves the same
      // row. `email` is nullable/unique; a blank lookup can never match a NULL.
      const [row] = await db
        .select()
        .from(users)
        .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
        .limit(1);
      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },

    async setPasswordHash(id, passwordHash) {
      await db.update(users).set({ passwordHash }).where(eq(users.id, id));
    },

    async setEmail(id, email) {
      // A new address is unproven — clear verification in the same write.
      await db.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, id));
    },

    async setEmailVerifiedAt(id, at) {
      await db.update(users).set({ emailVerifiedAt: at }).where(eq(users.id, id));
    },
  };
}
