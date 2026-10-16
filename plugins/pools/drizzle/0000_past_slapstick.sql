CREATE TABLE "pools_posts" (
	"pool_id" bigint NOT NULL,
	"asset_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pools_posts_pool_id_asset_id_pk" PRIMARY KEY("pool_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "pools_pools" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"creator_id" bigint,
	"creator_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pools_posts" ADD CONSTRAINT "pools_posts_pool_id_pools_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pools_posts_order_idx" ON "pools_posts" USING btree ("pool_id","position");--> statement-breakpoint
CREATE INDEX "pools_posts_asset_idx" ON "pools_posts" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_pools_name_lower_idx" ON "pools_pools" USING btree (lower("name"));