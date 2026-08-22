import { fileURLToPath } from "node:url";

import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import type { DB } from "./client";

/**
 * Fixed key for the session advisory lock that serializes boot-time Core
 * migrations. drizzle-orm doesn't lock, so without this two replicas booting at
 * once could run the same DDL and one would fail. Arbitrary but stable.
 */
const CORE_MIGRATION_LOCK_KEY = 4_010_202_507;

/**
 * A set of Drizzle migrations to apply: the folder of generated SQL plus the
 * table that tracks which have run. Plugins pass a dedicated `migrationsTable`
 * (e.g. `__drizzle_migrations_<id>`) so their history never collides with
 * Core's default `__drizzle_migrations`.
 */
export interface MigrationSet {
  /** Absolute path to the folder of generated `*.sql` migrations. */
  migrationsFolder: string;
  /** Tracking table name (defaults to Drizzle's `__drizzle_migrations`). */
  migrationsTable?: string;
}

/**
 * Apply every pending migration in {@link MigrationSet.migrationsFolder} to
 * `db`, tracking applied migrations in {@link MigrationSet.migrationsTable}.
 * Idempotent: already-applied migrations are skipped. This is the one code path
 * (besides the CLI runner) allowed to execute schema DDL — kept in `@bunbooru/db`
 * so callers depend on Core, not on the migrator directly.
 */
export async function applyMigrations(db: DB, set: MigrationSet): Promise<void> {
  await migrate(db, set);
}

/**
 * Absolute path to Core's own generated migrations (`packages/db/drizzle`),
 * resolved relative to this module so callers never hardcode it. Works when the
 * package runs from source (dev/CI); bundling this SQL into the production
 * single-file binary is a separate follow-up (same caveat as plugin migrations).
 */
export const CORE_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Apply all pending CORE migrations. The API composition root calls this on boot
 * so a freshly-added migration takes effect without a manual step (the same
 * convention plugin migrations follow). Idempotent.
 *
 * Runs on a DEDICATED single connection (`max: 1`) under a Postgres session
 * advisory lock, so the lock + `migrate` share one session and concurrent
 * replicas booting together can't execute the same DDL (the loser waits, then
 * finds nothing pending). Takes the connection URL rather than a shared handle
 * precisely so the lock's session is the one the migration runs on.
 */
export async function applyCoreMigrations(url: string): Promise<void> {
  const client = new SQL(url, { max: 1 });
  const db = drizzle({ client });
  try {
    await db.execute(sql`SELECT pg_advisory_lock(${CORE_MIGRATION_LOCK_KEY})`);
    try {
      await migrate(db, { migrationsFolder: CORE_MIGRATIONS_FOLDER });
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${CORE_MIGRATION_LOCK_KEY})`);
    }
  } finally {
    await client.close();
  }
}
