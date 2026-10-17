CREATE TABLE "comments_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" bigint NOT NULL,
	"author_id" bigint,
	"author_name" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_comments_asset_idx" ON "comments_comments" USING btree ("asset_id","id");--> statement-breakpoint
CREATE INDEX "comments_comments_recent_idx" ON "comments_comments" USING btree ("id" DESC NULLS LAST);