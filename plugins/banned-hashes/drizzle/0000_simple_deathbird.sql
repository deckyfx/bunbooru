CREATE TABLE "banned_hashes_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sha256" text,
	"md5" text,
	"reason" text DEFAULT '' NOT NULL,
	"banned_by_id" bigint,
	"banned_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banned_hashes_entries_has_hash" CHECK ("banned_hashes_entries"."sha256" is not null or "banned_hashes_entries"."md5" is not null),
	CONSTRAINT "banned_hashes_entries_sha256_hex" CHECK ("banned_hashes_entries"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "banned_hashes_entries_md5_hex" CHECK ("banned_hashes_entries"."md5" ~ '^[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "banned_hashes_entries_sha256_idx" ON "banned_hashes_entries" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "banned_hashes_entries_md5_idx" ON "banned_hashes_entries" USING btree ("md5");