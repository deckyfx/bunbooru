ALTER TABLE "mail_settings" ADD COLUMN "host" text;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD COLUMN "port" integer;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD COLUMN "secure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD COLUMN "password" text;