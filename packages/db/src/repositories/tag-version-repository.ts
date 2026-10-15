import { and, desc, eq, lt } from "drizzle-orm";

import type { DB } from "../client";
import { assetTagVersions, users } from "../schema";

/**
 * One recorded change to a post's tags. Written by `TagRepository.setAssetTags`
 * in the same transaction as the change itself; this repository only reads.
 */
export interface TagVersion {
  id: number;
  assetId: number;
  /** Who made the edit; null for a system/plugin edit or a deleted account. */
  userId: number | null;
  username: string | null;
  /** The complete tag set after this edit (what a revert restores). */
  tags: string[];
  added: string[];
  removed: string[];
  createdAt: Date;
}

export interface TagVersionRepository {
  /**
   * An asset's versions, newest first. Keyset-paginated: pass the smallest id of
   * the previous page as `beforeId` for the next one, which stays fast however
   * long a post's history grows (no OFFSET scan).
   */
  listForAsset(assetId: number, limit: number, beforeId?: number): Promise<TagVersion[]>;
  /** A version by id, or null. */
  findById(id: number): Promise<TagVersion | null>;
}

/** Build a {@link TagVersionRepository} over a {@link DB} handle. */
export function createTagVersionRepository(db: DB): TagVersionRepository {
  const select = () =>
    db
      .select({
        id: assetTagVersions.id,
        assetId: assetTagVersions.assetId,
        userId: assetTagVersions.userId,
        username: users.username,
        tags: assetTagVersions.tags,
        added: assetTagVersions.added,
        removed: assetTagVersions.removed,
        createdAt: assetTagVersions.createdAt,
      })
      .from(assetTagVersions)
      .leftJoin(users, eq(users.id, assetTagVersions.userId));

  return {
    listForAsset(assetId, limit, beforeId) {
      const scope = eq(assetTagVersions.assetId, assetId);
      return select()
        .where(beforeId === undefined ? scope : and(scope, lt(assetTagVersions.id, beforeId)))
        .orderBy(desc(assetTagVersions.id))
        .limit(limit);
    },

    async findById(id) {
      const [row] = await select().where(eq(assetTagVersions.id, id)).limit(1);
      return row ?? null;
    },
  };
}
