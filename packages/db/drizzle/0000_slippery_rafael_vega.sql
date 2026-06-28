CREATE TYPE "public"."rating" AS ENUM('safe', 'questionable', 'explicit');--> statement-breakpoint
CREATE TYPE "public"."tag_category" AS ENUM('general', 'artist', 'character', 'copyright', 'meta');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member', 'guest');--> statement-breakpoint
CREATE TABLE "asset_tags" (
	"asset_id" bigint NOT NULL,
	"tag_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tags_asset_id_tag_id_pk" PRIMARY KEY("asset_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"md5" text NOT NULL,
	"rating" "rating" DEFAULT 'questionable' NOT NULL,
	"source" text,
	"uploader_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_md5_unique" UNIQUE("md5")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" "tag_category" DEFAULT 'general' NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "asset_tags" ADD CONSTRAINT "asset_tags_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tags" ADD CONSTRAINT "asset_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_tags_tag_idx" ON "asset_tags" USING btree ("tag_id");