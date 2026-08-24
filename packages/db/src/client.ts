import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

/**
 * A Drizzle database handle bound to the Core schema, backed by Bun's native
 * Postgres driver (`bun:sql`). The full schema is registered so relational
 * queries and inferred types are available everywhere.
 */
export type DB = ReturnType<typeof createDb>;

/**
 * Build a database handle for the given Postgres connection string.
 *
 * Connection-string injection (rather than a module-level singleton reading
 * `process.env`) keeps the `db` package free of environment coupling: the API
 * composition root passes `envConfig.DATABASE_URL`, and tests point at their own
 * database. Bun's `SQL` lazily connects, so constructing this does no I/O.
 *
 * @param url - Postgres connection string, e.g. `postgres://user:pass@host:5432/db`.
 * @param options.max - Maximum pooled connections. Omitted, Bun's default (10)
 *   applies, which is right for a single long-lived server process. It is NOT
 *   right when many handles exist at once: the integration suites build one per
 *   test file and, alongside a running dev server, ten default pools exhaust
 *   Postgres' 100-connection ceiling (`53300`). Callers that fan out set this
 *   low; {@link DB_POOL_MAX_ENV} lets the test preload cap them all at once.
 */
export function createDb(url: string, options: { max?: number } = {}) {
  const configured = Number(Bun.env[DB_POOL_MAX_ENV]);
  const max = options.max ?? (Number.isFinite(configured) && configured > 0 ? configured : undefined);
  return drizzle({ client: new SQL(url, max === undefined ? {} : { max }), schema });
}

/**
 * Env var capping the pool size of every handle built without an explicit `max`.
 * Exists so a process that creates many handles (the test runner) can bound them
 * globally without threading an option through every call site.
 */
export const DB_POOL_MAX_ENV = "DB_POOL_MAX";
