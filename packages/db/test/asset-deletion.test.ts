import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  assetTags,
  assetTombstones,
  createAssetRepository,
  createDb,
  createTagRepository,
  tags as tagsTable,
  type AssetRepository,
  type DB,
  type TagRepository,
} from "../src/index";

/**
 * `AssetRepository.deleteWithTombstone` against a real Postgres (see
 * asset-repository.test for the opt-in `TEST_DATABASE_URL` rationale): the row
 * goes with its tag links, the tag counters follow, a tombstone keeps the
 * hashes, and the content key is free for a later re-upload.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

/** Canonical lowercase-hex digest, satisfying the schema's hex CHECK constraints. */
function hexDigest(algo: "sha256" | "md5", input: string): string {
  return new Bun.CryptoHasher(algo).update(input).digest("hex");
}

/** Minimal valid asset insert keyed by `key`. */
function seed(key: string) {
  return {
    storageKey: `assets/${key}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: 1,
    sha256: hexDigest("sha256", `sha:${key}`),
    md5: hexDigest("md5", `md5:${key}`),
  };
}

describe.skipIf(!TEST_DATABASE_URL)("AssetRepository.deleteWithTombstone (integration)", () => {
  let db: DB;
  let assets: AssetRepository;
  let tags: TagRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    assets = createAssetRepository(db);
    tags = createTagRepository(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE assets, tags, asset_tags, asset_tombstones RESTART IDENTITY CASCADE`,
    );
  });

  /** A tag's stored post_count, by name. */
  async function postCount(name: string): Promise<number | undefined> {
    const [row] = await db
      .select({ n: tagsTable.postCount })
      .from(tagsTable)
      .where(eq(tagsTable.name, name));
    return row?.n;
  }

  it("deletes the post and its tag links, decrements counts, and writes a tombstone", async () => {
    const doomed = await assets.create(seed("doomed"));
    const kept = await assets.create(seed("kept"));
    const [cat, dog] = await tags.getOrCreateByNames(["cat", "dog"]);
    await tags.setAssetTags(doomed.id, [cat!.id, dog!.id], null);
    await tags.setAssetTags(kept.id, [cat!.id], null);
    expect(await postCount("cat")).toBe(2);

    const now = new Date("2026-10-17T12:00:00.000Z");
    const deleted = await assets.deleteWithTombstone(doomed.id, { deletedById: 42, reason: "dupe", now });

    expect(deleted).toEqual({
      id: doomed.id,
      storageKey: doomed.storageKey,
      sha256: doomed.sha256,
      md5: doomed.md5,
    });
    expect(await assets.findById(doomed.id)).toBeNull();
    expect(await assets.findById(kept.id)).not.toBeNull();

    const links = await db.select().from(assetTags).where(eq(assetTags.assetId, doomed.id));
    expect(links).toEqual([]);
    expect(await postCount("cat")).toBe(1);
    expect(await postCount("dog")).toBe(0);

    const stones = await db.select().from(assetTombstones);
    expect(stones).toHaveLength(1);
    expect(stones[0]).toMatchObject({
      assetId: doomed.id,
      sha256: doomed.sha256,
      md5: doomed.md5,
      deletedById: 42,
      reason: "dupe",
      deletedAt: now,
    });
  });

  it("returns null for a missing id and writes no tombstone", async () => {
    const now = new Date();
    expect(await assets.deleteWithTombstone(999_999, { deletedById: null, reason: "", now })).toBeNull();
    expect(await db.select().from(assetTombstones)).toEqual([]);
  });

  it("frees the sha256: the same bytes can be stored again, and deleted again", async () => {
    const first = await assets.create(seed("again"));
    const by = { deletedById: null, reason: "", now: new Date() };
    await assets.deleteWithTombstone(first.id, by);

    const second = await assets.create(seed("again"));
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).toBe(first.sha256);

    // Tombstones aren't unique per hash: a second deletion leaves a second one.
    await assets.deleteWithTombstone(second.id, by);
    const stones = await db
      .select({ assetId: assetTombstones.assetId })
      .from(assetTombstones)
      .where(eq(assetTombstones.sha256, first.sha256));
    expect(stones.map((s) => s.assetId).sort()).toEqual([first.id, second.id].sort());
  });
});
