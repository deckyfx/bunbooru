CREATE TABLE "shimmie_import_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_instance" text NOT NULL,
	"source_post_id" integer NOT NULL,
	"asset_id" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shimmie_import_items_source_instance_source_post_id_unique" UNIQUE("source_instance","source_post_id")
);
--> statement-breakpoint
CREATE TABLE "shimmie_import_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_instance" text NOT NULL,
	"user_filter" text NOT NULL,
	"source_timezone" text DEFAULT 'UTC' NOT NULL,
	"target_user_id" integer NOT NULL,
	"max_id" integer NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
