CREATE TABLE "thumbnails" (
	"asset_id" integer PRIMARY KEY NOT NULL,
	"storage_key" text,
	"width" integer,
	"height" integer,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
