/**
 * CLI migration runner: applies every pending Drizzle migration in `./drizzle`
 * to the database named by `DATABASE_URL`, then exits.
 *
 * Invoked by `bun run migrate` (locally and in CI before the test suite). Schema
 * changes flow: edit `schema.ts` → `bun run db:generate` → review SQL → `bun run
 * migrate`.
 */
import { applyCoreMigrations } from "./migrator";

const url = Bun.env.DATABASE_URL;
if (!url) {
  console.error("✖ DATABASE_URL is required to run migrations");
  process.exit(1);
}

console.log("▶ Applying migrations…");
try {
  // Same code path (advisory-locked, one source of truth) the API uses on boot.
  await applyCoreMigrations(url);
  console.log("✔ Migrations applied.");
} catch (error) {
  console.error("✖ Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}

// Bun's SQL pool keeps the process alive; exit explicitly once done.
process.exit(0);
