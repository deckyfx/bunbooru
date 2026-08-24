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
  const max = resolvePoolMax(options.max, Bun.env[DB_POOL_MAX_ENV]);
  return drizzle({ client: new SQL(url, max === undefined ? {} : { max }), schema });
}

/**
 * Decide the pool size from an explicit option and the environment.
 *
 * Pure and exported so the parsing is testable without opening a handle. An
 * explicit `max` always wins, including over the environment. Anything that is
 * not a positive finite number — `0`, a negative, `NaN` from a non-numeric or
 * empty string — yields `undefined`, meaning "no cap, use Bun's default": a
 * malformed value must not silently become a pool of zero connections, which
 * would deadlock every query.
 *
 * @param explicit - `options.max` from the caller, if any.
 * @param fromEnv - Raw `DB_POOL_MAX` value, if set.
 */
export function resolvePoolMax(
  explicit: number | undefined,
  fromEnv: string | undefined,
): number | undefined {
  const usable = (n: number): boolean => Number.isFinite(n) && n > 0;
  if (explicit !== undefined) return usable(explicit) ? explicit : undefined;
  const raw = fromEnv?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return usable(parsed) ? parsed : undefined;
}

/**
 * Env var capping the pool size of every handle built without an explicit `max`.
 * Exists so a process that creates many handles (the test runner) can bound them
 * globally without threading an option through every call site.
 */
export const DB_POOL_MAX_ENV = "DB_POOL_MAX";
