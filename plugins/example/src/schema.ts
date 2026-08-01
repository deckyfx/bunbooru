import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A plugin-OWNED table, declared entirely within this plugin (never in
 * `@bunbooru/db`'s Core schema). It proves the plugin-tables mechanism: the host
 * applies this plugin's migrations under a dedicated tracking table, and the
 * plugin reads/writes it through `ctx.db`.
 */
export const examplePings = pgTable("example_pings", {
  id: serial("id").primaryKey(),
  note: text("note").notNull(),
  // `withTimezone` (timestamptz) matches every Core table — a bare `timestamp`
  // drops the offset, so a runtime in another zone would serialize a different
  // instant.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
