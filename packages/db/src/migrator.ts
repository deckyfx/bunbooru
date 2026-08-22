import { fileURLToPath } from "node:url";

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

/**
 * Absolute path to Core's own generated migrations (`packages/db/drizzle`),
 * resolved relative to this module so callers never hardcode it. Works when the
 * package runs from source (dev/CI); bundling this SQL into the production
 * single-file binary is a separate follow-up (same caveat as plugin migrations).
 */
export const CORE_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Apply all pending CORE migrations to `db`. The API composition root calls this
 * on boot so a freshly-added migration takes effect without a manual step (the
 * same convention plugin migrations already follow). Idempotent.
 */
export async function applyCoreMigrations(db: DB): Promise<void> {
  await applyMigrations(db, { migrationsFolder: CORE_MIGRATIONS_FOLDER });
}
