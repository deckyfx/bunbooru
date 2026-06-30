-- Maintain tags.post_count at the source: AFTER INSERT/DELETE on asset_tags.
-- This keeps the denormalized counter correct for EVERY path that mutates the
-- join — TagRepository.setAssetTags, ON DELETE CASCADE when an asset is removed,
-- or any direct SQL — so it can't drift (a manual decrement-on-set alone misses
-- cascade deletes). The post_count >= 0 CHECK holds because a deleted link row
-- must have previously incremented the count.
CREATE OR REPLACE FUNCTION asset_tags_maintain_post_count() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE tags SET post_count = post_count + 1 WHERE id = NEW.tag_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE tags SET post_count = post_count - 1 WHERE id = OLD.tag_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER asset_tags_post_count_insert
  AFTER INSERT ON asset_tags
  FOR EACH ROW EXECUTE FUNCTION asset_tags_maintain_post_count();
--> statement-breakpoint
CREATE TRIGGER asset_tags_post_count_delete
  AFTER DELETE ON asset_tags
  FOR EACH ROW EXECUTE FUNCTION asset_tags_maintain_post_count();
