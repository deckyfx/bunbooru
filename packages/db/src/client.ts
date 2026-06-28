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
 */
export function createDb(url: string) {
  return drizzle({ client: new SQL(url), schema });
}
