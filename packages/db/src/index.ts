/**
 * `@bunbooru/db` — Drizzle schemas, repositories, migrations, transactions.
 *
 * The only layer permitted to execute SQL. Repositories never know HTTP.
 * Schemas and the Drizzle connection land in a later PR.
 */
export const DB_PACKAGE = "@bunbooru/db" as const;
