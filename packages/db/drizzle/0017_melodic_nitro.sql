CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "jobs_attempts_nonneg" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_positive" CHECK ("jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_kind_status_idx" ON "jobs" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_pending_idx" ON "jobs" USING btree ("idempotency_key") WHERE "jobs"."status" in ('queued', 'running');