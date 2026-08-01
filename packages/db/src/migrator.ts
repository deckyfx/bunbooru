import { migrate } from "drizzle-orm/bun-sql/migrator";

import type { DB } from "./client";

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
