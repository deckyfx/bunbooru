import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAssetRepository,
  createDb,
  createTagRepository,
  type AssetRepository,
  type DB,
  type TagRepository,
} from "../src/index";

/**
 * Integration tests against a real Postgres (see asset-repository.test for the
 * opt-in `TEST_DATABASE_URL` rationale). These specifically lock down the
 * `postCount` denormalized counter — that it tracks the join transactionally and
 * never drifts or goes negative.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

/** SHA-256-shaped hex digest unique per key (passes the assets hex CHECK). */
function digest(key: string, len: number): string {
  const hasher = new Bun.CryptoHasher("sha256").update(key).digest("hex");
  return hasher.slice(0, len);
}

describe.skipIf(!TEST_DATABASE_URL)("TagRepository (integration)", () => {
  let db: DB;
  let tags: TagRepository;
  let assets: AssetRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    tags = createTagRepository(db);
    assets = createAssetRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE assets, tags, asset_tags RESTART IDENTITY CASCADE`);
  });

  /** Insert a minimal asset and return its id (asset_tags needs a real FK). */
  async function seedAsset(key: string): Promise<number> {
    const asset = await assets.create({
      storageKey: `assets/${key}`,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sizeBytes: 1,
      sha256: digest(`sha:${key}`, 64),
      md5: digest(`md5:${key}`, 32),
    });
    return asset.id;
  }

  it("getOrCreateByNames creates missing names and is idempotent", async () => {
    const first = await tags.getOrCreateByNames(["1girl", "solo"]);
    expect(first.map((t) => t.name).sort()).toEqual(["1girl", "solo"]);

    const second = await tags.getOrCreateByNames(["1girl", "smile"]);
    // "1girl" reused (same id), "smile" created, no duplicate rows.
    expect(second.find((t) => t.name === "1girl")?.id).toBe(
      first.find((t) => t.name === "1girl")?.id,
    );
    const all = await tags.searchByPrefix("", 100);
    expect(all.map((t) => t.name).sort()).toEqual(["1girl", "smile", "solo"]);
  });

  it("setAssetTags links tags, maintains postCount, and lists them in order", async () => {
    const assetId = await seedAsset("a");
    const rows = await tags.getOrCreateByNames(["solo", "1girl"]);
    await tags.setAssetTags(
      assetId,
      rows.map((t) => t.id),
    );

    const listed = await tags.listForAsset(assetId);
    expect(listed.map((t) => t.name)).toEqual(["1girl", "solo"]); // category 'general', name asc
    expect(listed.every((t) => t.postCount === 1)).toBe(true);
  });

  it("applies the diff and adjusts postCount both ways", async () => {
    const a1 = await seedAsset("a1");
    const a2 = await seedAsset("a2");
    // getOrCreateByNames doesn't guarantee input order — key by name, not position.
    const byName = new Map(
      (await tags.getOrCreateByNames(["1girl", "solo", "smile"])).map((t) => [t.name, t]),
    );
    const oneGirl = byName.get("1girl")!;
    const solo = byName.get("solo")!;
    const smile = byName.get("smile")!;

    await tags.setAssetTags(a1, [oneGirl.id, solo.id]);
    await tags.setAssetTags(a2, [oneGirl.id]); // 1girl now on two assets
    // Re-tag a1: drop solo, add smile.
    await tags.setAssetTags(a1, [oneGirl.id, smile.id]);

    const counts = Object.fromEntries(
      (await tags.searchByPrefix("", 100)).map((t) => [t.name, t.postCount]),
    );
    expect(counts["1girl"]).toBe(2); // on a1 + a2
    expect(counts["solo"]).toBe(0); // removed from a1
    expect(counts["smile"]).toBe(1); // added to a1
  });

  it("decrements postCount when an asset is deleted (cascade trigger)", async () => {
    const assetId = await seedAsset("a");
    const rows = await tags.getOrCreateByNames(["1girl", "solo"]);
    await tags.setAssetTags(
      assetId,
      rows.map((t) => t.id),
    );
    expect((await tags.findByName("1girl"))?.postCount).toBe(1);

    // Deleting the asset cascades the asset_tags rows; the trigger must keep
    // post_count in sync (a manual setAssetTags decrement alone wouldn't fire).
    await db.execute(sql`DELETE FROM assets WHERE id = ${assetId}`);

    expect((await tags.findByName("1girl"))?.postCount).toBe(0);
    expect((await tags.findByName("solo"))?.postCount).toBe(0);
  });

  it("re-applying the same set is a no-op (postCount unchanged)", async () => {
    const assetId = await seedAsset("a");
    const rows = await tags.getOrCreateByNames(["1girl"]);
    await tags.setAssetTags(assetId, [rows[0]!.id]);
    await tags.setAssetTags(assetId, [rows[0]!.id]);
    expect((await tags.findByName("1girl"))?.postCount).toBe(1);
  });

  it("searchByPrefix orders by popularity and respects the limit", async () => {
    const a = await seedAsset("a");
    const byName = new Map(
      (await tags.getOrCreateByNames(["sky", "skyscraper"])).map((t) => [t.name, t]),
    );
    // Make "sky" more popular by linking it to an asset.
    await tags.setAssetTags(a, [byName.get("sky")!.id]);

    const results = await tags.searchByPrefix("sky", 10);
    expect(results.map((t) => t.name)).toEqual(["sky", "skyscraper"]); // postCount desc
    expect((await tags.searchByPrefix("sky", 1)).map((t) => t.name)).toEqual(["sky"]);
  });

  it("setCategory updates an existing tag and returns null for a missing one", async () => {
    await tags.getOrCreateByNames(["hatsune_miku"]);
    expect((await tags.setCategory("hatsune_miku", "character"))?.category).toBe("character");
    expect(await tags.setCategory("nope", "artist")).toBeNull();
  });

  it("relatedTags ranks co-occurring tags, excludes itself, and respects the limit", async () => {
    const [a1, a2, a3] = [await seedAsset("r1"), await seedAsset("r2"), await seedAsset("r3")];
    const byName = new Map(
      (await tags.getOrCreateByNames(["1girl", "solo", "smile", "hat"])).map((t) => [t.name, t]),
    );
    const id = (n: string) => byName.get(n)!.id;
    // 1girl+solo share a1,a2 (2); 1girl+smile share a1,a3 (2); 1girl+hat share a1 (1).
    await tags.setAssetTags(a1, [id("1girl"), id("solo"), id("smile"), id("hat")]);
    await tags.setAssetTags(a2, [id("1girl"), id("solo")]);
    await tags.setAssetTags(a3, [id("1girl"), id("smile")]);

    const related = await tags.relatedTags("1girl", 10);
    const names = related.map((t) => t.name);
    expect(names).not.toContain("1girl"); // never itself
    expect(names).toEqual(["smile", "solo", "hat"]); // 2,2,1 — ties broken by postCount/name
    // hat co-occurs once; solo/smile twice — so `hat` is dropped at limit 2.
    expect((await tags.relatedTags("1girl", 2)).map((t) => t.name)).not.toContain("hat");
    // Unknown tag → empty.
    expect(await tags.relatedTags("ghost", 10)).toEqual([]);
  });
});
