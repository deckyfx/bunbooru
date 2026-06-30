CREATE TABLE "upload_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"declared_size" bigint NOT NULL,
	"uploaded_size" bigint DEFAULT 0 NOT NULL,
	"staging_key" text NOT NULL,
	"uploader_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upload_sessions_token_unique" UNIQUE("token"),
	CONSTRAINT "upload_sessions_declared_size_nonneg" CHECK ("upload_sessions"."declared_size" >= 0),
	CONSTRAINT "upload_sessions_uploaded_size_range" CHECK ("upload_sessions"."uploaded_size" >= 0 and "upload_sessions"."uploaded_size" <= "upload_sessions"."declared_size")
);
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;