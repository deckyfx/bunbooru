CREATE TABLE "asset_tombstones" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" bigint NOT NULL,
	"sha256" text NOT NULL,
	"md5" text NOT NULL,
	"deleted_by_id" bigint,
	"reason" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "asset_tombstones_sha256_idx" ON "asset_tombstones" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "asset_tombstones_md5_idx" ON "asset_tombstones" USING btree ("md5");