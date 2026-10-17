CREATE TABLE "notes_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" bigint NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"w" double precision NOT NULL,
	"h" double precision NOT NULL,
	"body" text NOT NULL,
	"author_id" bigint,
	"author_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_notes_x_check" CHECK ("notes_notes"."x" >= 0),
	CONSTRAINT "notes_notes_y_check" CHECK ("notes_notes"."y" >= 0),
	CONSTRAINT "notes_notes_w_check" CHECK ("notes_notes"."w" > 0),
	CONSTRAINT "notes_notes_h_check" CHECK ("notes_notes"."h" > 0),
	CONSTRAINT "notes_notes_right_check" CHECK ("notes_notes"."x" + "notes_notes"."w" <= 1 + 1e-9),
	CONSTRAINT "notes_notes_bottom_check" CHECK ("notes_notes"."y" + "notes_notes"."h" <= 1 + 1e-9)
);
--> statement-breakpoint
CREATE INDEX "notes_notes_asset_idx" ON "notes_notes" USING btree ("asset_id");