import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration for the example plugin's OWN schema.
 *
 * `generate` reads this plugin's `schema.ts` and emits SQL into its `./drizzle`
 * folder — independent of Core's migrations. At runtime the host applies these
 * under a dedicated tracking table (`__drizzle_migrations_example`) so the two
 * histories never collide.
 *
 * Note: drizzle-kit evaluates this under Node, not Bun, so it reads
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
