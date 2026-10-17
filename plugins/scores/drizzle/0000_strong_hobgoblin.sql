CREATE TABLE "scores_totals" (
	"asset_id" bigint PRIMARY KEY NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"up" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores_votes" (
	"asset_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_votes_asset_id_user_id_pk" PRIMARY KEY("asset_id","user_id"),
	CONSTRAINT "scores_votes_value_check" CHECK ("scores_votes"."value" in (-1, 1))
);
--> statement-breakpoint
CREATE INDEX "scores_totals_score_idx" ON "scores_totals" USING btree ("score");