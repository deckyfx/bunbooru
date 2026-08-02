CREATE TABLE "plugin_states" (
	"id" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
