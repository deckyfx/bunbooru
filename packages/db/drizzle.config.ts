import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration for the Core schema.
 *
 * `generate` reads `schema.ts` and emits SQL into `./drizzle` without touching a
 * database; the `dbCredentials` URL is only consulted by commands that connect
 * (e.g. `studio`), so it falls back to the local compose defaults.
 *
 * Note: drizzle-kit evaluates this file under Node, not Bun, so it reads
 * `process.env` (the `Bun.env` global is unavailable here).
 */
export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://bunbooru:bunbooru@localhost:5432/bunbooru",
  },
} satisfies Config;
