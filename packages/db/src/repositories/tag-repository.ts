import { and, asc, desc, eq, inArray, like } from "drizzle-orm";

import { assets, assetTags, tags, type Tag, type TagCategory } from "../schema";
import type { DB } from "../client";

/**
 * Data access for {@link Tag} rows and the asset↔tag join (the only place tag
 * SQL lives, per CLAUDE.md). The `postCount` denormalized counter is maintained
 * here, in the same transaction as the join writes, so it can never drift from
 * the actual number of links.
 */
export interface TagRepository {
  /** A tag by its exact (already-normalized) name, or null. */
  findByName(name: string): Promise<Tag | null>;
  /**
   * Resolve `names` to tag rows, inserting any that don't exist yet (default
   * category `general`). Returns one row per distinct input name. Names are
   * assumed already normalized by the caller (the tag service).
   */
  getOrCreateByNames(names: string[]): Promise<Tag[]>;
  /** The tags linked to an asset, ordered by category then name (booru order). */
  listForAsset(assetId: number): Promise<Tag[]>;
  /**
   * Replace an asset's tag set with exactly `tagIds`, in one transaction:
   * link added tags, unlink removed ones, and adjust each affected tag's
   * `postCount` by the matching delta. Idempotent — re-applying the same set is
   * a no-op.
   */
  setAssetTags(assetId: number, tagIds: number[]): Promise<void>;
  /**
   * Name-prefix search ordered by popularity (`postCount` desc) for
   * autocomplete; `limit` bounds the result set.
   */
  searchByPrefix(prefix: string, limit: number): Promise<Tag[]>;
  /** Change a tag's category, returning the updated row or null if absent. */
  setCategory(name: string, category: TagCategory): Promise<Tag | null>;
}

/** Escape LIKE metacharacters so a user prefix is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Build a {@link TagRepository} over a {@link DB} handle. */
export function createTagRepository(db: DB): TagRepository {
  return {
    async findByName(name) {
      const [row] = await db.select().from(tags).where(eq(tags.name, name)).limit(1);
      return row ?? null;
    },

    async getOrCreateByNames(names) {
      const unique = [...new Set(names)];
      if (unique.length === 0) return [];
      // Insert any missing names (ignore conflicts on the unique `name`), then
      // read all requested rows back — one round-trip each, conflict-safe under
      // concurrent uploads tagging the same new name.
      await db
        .insert(tags)
        .values(unique.map((name) => ({ name })))
        .onConflictDoNothing({ target: tags.name });
      return db.select().from(tags).where(inArray(tags.name, unique));
    },

    async listForAsset(assetId) {
      return db
        .select({
          id: tags.id,
          name: tags.name,
          category: tags.category,
          postCount: tags.postCount,
          createdAt: tags.createdAt,
        })
        .from(assetTags)
        .innerJoin(tags, eq(assetTags.tagId, tags.id))
        .where(eq(assetTags.assetId, assetId))
        .orderBy(asc(tags.category), asc(tags.name));
    },

    async setAssetTags(assetId, tagIds) {
      const desired = [...new Set(tagIds)];
      await db.transaction(async (tx) => {
        // Lock the owning asset row so concurrent edits to the SAME asset's tags
        // serialize: without this, two writers could read the same `current` set
        // and commit a merged result neither asked for (the "replace with exactly
        // tagIds" contract). FK guarantees the row exists for a valid asset.
        await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).for("update");

        const current = await tx
          .select({ tagId: assetTags.tagId })
          .from(assetTags)
          .where(eq(assetTags.assetId, assetId));
        const currentIds = new Set(current.map((r) => r.tagId));
        const desiredIds = new Set(desired);

        const toAdd = desired.filter((id) => !currentIds.has(id));
        const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

        // Link/unlink only — `tags.post_count` is maintained by the
        // asset_tags AFTER INSERT/DELETE trigger (migration 0005), so it stays
        // correct here AND on ON DELETE CASCADE when an asset is removed.
        if (toAdd.length > 0) {
          await tx.insert(assetTags).values(toAdd.map((tagId) => ({ assetId, tagId })));
        }
        if (toRemove.length > 0) {
          await tx
            .delete(assetTags)
            .where(and(eq(assetTags.assetId, assetId), inArray(assetTags.tagId, toRemove)));
        }
      });
    },

    async searchByPrefix(prefix, limit) {
      return db
        .select()
        .from(tags)
        .where(like(tags.name, `${escapeLike(prefix)}%`))
        .orderBy(desc(tags.postCount), asc(tags.name))
        .limit(limit);
    },

    async setCategory(name, category) {
      const [row] = await db
        .update(tags)
        .set({ category })
        .where(eq(tags.name, name))
        .returning();
      return row ?? null;
    },
  };
}
