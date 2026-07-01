CREATE TABLE "daily_visitors" (
	"day" date NOT NULL,
	"visitor_id" text NOT NULL,
	CONSTRAINT "daily_visitors_day_visitor_id_pk" PRIMARY KEY("day","visitor_id")
);
--> statement-breakpoint
CREATE TABLE "post_views" (
	"visitor_id" text NOT NULL,
	"asset_id" bigint NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_views_visitor_id_asset_id_pk" PRIMARY KEY("visitor_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "view_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_views" ADD CONSTRAINT "post_views_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_views_asset_idx" ON "post_views" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_view_count_nonneg" CHECK ("assets"."view_count" >= 0);