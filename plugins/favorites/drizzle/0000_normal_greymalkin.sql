CREATE TABLE "favorites_posts" (
	"user_id" bigint NOT NULL,
	"asset_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_posts_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
CREATE INDEX "favorites_posts_asset_idx" ON "favorites_posts" USING btree ("asset_id");