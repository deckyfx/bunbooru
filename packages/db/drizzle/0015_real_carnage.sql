CREATE TABLE "asset_tag_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" bigint NOT NULL,
	"user_id" bigint,
	"tags" text[] NOT NULL,
	"added" text[] NOT NULL,
	"removed" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_aliases" (
	"antecedent_name" text PRIMARY KEY NOT NULL,
	"consequent_id" bigint NOT NULL,
	"creator_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_implications" (
	"antecedent_id" bigint NOT NULL,
	"consequent_id" bigint NOT NULL,
	"creator_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_implications_antecedent_id_consequent_id_pk" PRIMARY KEY("antecedent_id","consequent_id"),
	CONSTRAINT "tag_implications_not_self" CHECK ("tag_implications"."antecedent_id" <> "tag_implications"."consequent_id")
);
--> statement-breakpoint
ALTER TABLE "asset_tag_versions" ADD CONSTRAINT "asset_tag_versions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tag_versions" ADD CONSTRAINT "asset_tag_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_aliases" ADD CONSTRAINT "tag_aliases_consequent_id_tags_id_fk" FOREIGN KEY ("consequent_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_aliases" ADD CONSTRAINT "tag_aliases_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_implications" ADD CONSTRAINT "tag_implications_antecedent_id_tags_id_fk" FOREIGN KEY ("antecedent_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_implications" ADD CONSTRAINT "tag_implications_consequent_id_tags_id_fk" FOREIGN KEY ("consequent_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_implications" ADD CONSTRAINT "tag_implications_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_tag_versions_asset_idx" ON "asset_tag_versions" USING btree ("asset_id","id");--> statement-breakpoint
CREATE INDEX "tag_aliases_consequent_idx" ON "tag_aliases" USING btree ("consequent_id");--> statement-breakpoint
CREATE INDEX "tag_implications_consequent_idx" ON "tag_implications" USING btree ("consequent_id");