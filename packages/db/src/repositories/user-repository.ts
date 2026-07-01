import { eq, sql } from "drizzle-orm";

import { users, type NewUser, type User } from "../schema";
import type { DB } from "../client";

/**
 * Advisory-lock key that serializes the first-user (admin) bootstrap. Arbitrary
 * but stable so every concurrent registration contends on the same lock.
 */
const USERS_BOOTSTRAP_LOCK = 987_654_321;

/**
 * Data access for {@link User} rows (the sole SQL layer per CLAUDE.md). Username
 * uniqueness/lookup is case-sensitive here — the auth service normalizes
 * usernames to lowercase before calling in, so callers must pass an
 * already-normalized value to {@link UserRepository.findByUsername}.
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
  /** One user by (normalized) username, or null. */
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
          .values({ ...input, role })
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
      const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ?? null;
    },
  };
}
