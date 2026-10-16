ALTER TABLE "assets" ADD COLUMN "tag_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_created_at_id_idx" ON "assets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "assets_size_bytes_id_idx" ON "assets" USING btree ("size_bytes","id");--> statement-breakpoint
CREATE INDEX "assets_tag_count_id_idx" ON "assets" USING btree ("tag_count","id");--> statement-breakpoint
CREATE INDEX "assets_md5_idx" ON "assets" USING btree ("md5");--> statement-breakpoint
CREATE INDEX "assets_uploader_id_idx" ON "assets" USING btree ("uploader_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tag_count_nonneg" CHECK ("assets"."tag_count" >= 0);--> statement-breakpoint
-- Backfill tag_count for existing posts, then keep it current at the source:
-- AFTER INSERT/DELETE on asset_tags, exactly like tags.post_count (migration
-- 0005), so every path that changes the join — setAssetTags, alias migration,
-- implication backfill, cascades — keeps it right without application code.
UPDATE "assets" SET "tag_count" = counted.n
  FROM (SELECT "asset_id", count(*)::int AS n FROM "asset_tags" GROUP BY "asset_id") AS counted
 WHERE "assets"."id" = counted."asset_id";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION asset_tags_maintain_tag_count() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE assets SET tag_count = tag_count + 1 WHERE id = NEW.asset_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    -- When the asset itself is being deleted (ON DELETE CASCADE), its row is
    -- already gone and this UPDATE matches nothing, which is exactly right.
    UPDATE assets SET tag_count = tag_count - 1 WHERE id = OLD.asset_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER asset_tags_tag_count_insert
  AFTER INSERT ON asset_tags
  FOR EACH ROW EXECUTE FUNCTION asset_tags_maintain_tag_count();
--> statement-breakpoint
CREATE TRIGGER asset_tags_tag_count_delete
  AFTER DELETE ON asset_tags
  FOR EACH ROW EXECUTE FUNCTION asset_tags_maintain_tag_count();
