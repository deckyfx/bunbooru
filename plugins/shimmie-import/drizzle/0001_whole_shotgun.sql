-- Add run_id safely on a non-empty table: Postgres rejects ADD COLUMN NOT NULL
-- without a DEFAULT when rows exist. Add with a transient DEFAULT (backfilling any
-- pre-existing rows with 0 — a sentinel that matches no real run), then drop it so
-- future inserts must supply run_id (the plugin always does). End state matches the
-- Drizzle snapshot: NOT NULL, no default.
ALTER TABLE "shimmie_import_items" ADD COLUMN "run_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shimmie_import_items" ALTER COLUMN "run_id" DROP DEFAULT;
