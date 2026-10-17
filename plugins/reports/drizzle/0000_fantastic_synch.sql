CREATE TABLE "reports_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" bigint NOT NULL,
	"reporter_id" bigint,
	"reporter_name" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reports_reports_status_check" CHECK ("reports_reports"."status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reports_open_reporter_idx" ON "reports_reports" USING btree ("asset_id","reporter_id") WHERE "reports_reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reports_reports_queue_idx" ON "reports_reports" USING btree ("status","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_reports_asset_idx" ON "reports_reports" USING btree ("asset_id");