CREATE TABLE "example_pings" (
	"id" serial PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
