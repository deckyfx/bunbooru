import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration for the shimmie-import plugin's OWN schema. Emits SQL
 * into this plugin's `./drizzle` folder, independent of Core; at runtime the host
 * applies it under `__drizzle_migrations_shimmie_import`.
 */
export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://bunbooru:bunbooru@localhost:5432/bunbooru",
  },
} satisfies Config;
