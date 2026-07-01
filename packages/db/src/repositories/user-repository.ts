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
 * are canonicalized to lowercase HERE — matching the `lower(username)` unique
 * index — so identity is case-insensitive regardless of how a caller cases the
 * input: `createBootstrapping` stores the lowercased form and `findByUsername`
 * matches on `lower(username)`.
 */
export interface UserRepository {
  /** Insert one user with an explicit role, returning the persisted row. */
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
  /** One user by id, or null. */
  findById(id: number): Promise<User | null>;
}

/** Build a {@link UserRepository} over a {@link DB} handle. */
export function createUserRepository(db: DB): UserRepository {
  return {
    async create(input) {
      const [row] = await db.insert(users).values(input).returning();
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

    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },
  };
}
