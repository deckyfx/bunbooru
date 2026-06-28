import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createAssetRepository, createDb, type AssetRepository, type DB } from "../src/index";

/**
 * Integration tests — they hit a real Postgres named by `DATABASE_URL` (the
 * migrations must already be applied). Skipped when it's unset so `bun test`
 * stays green on machines without a database; CI provides one and runs them.
 */
const DATABASE_URL = Bun.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("AssetRepository (integration)", () => {
  let db: DB;
  let repo: AssetRepository;

  beforeAll(() => {
    // Non-null: this block is skipped when DATABASE_URL is unset.
    db = createDb(DATABASE_URL as string);
    repo = createAssetRepository(db);
  });

  // Isolate every test on a clean table; CASCADE clears the asset_tags FK side.
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE assets, asset_tags RESTART IDENTITY CASCADE`);
  });

  it("starts empty", async () => {
    expect(await repo.count()).toBe(0);
    expect(await repo.findMany({ limit: 10, offset: 0 })).toEqual([]);
  });

  it("creates an asset and reads it back", async () => {
    const created = await repo.create({
      storageKey: "ab/cd/abcd.png",
      mimeType: "image/png",
      width: 800,
      height: 600,
      sizeBytes: 4096,
      md5: "abcd",
      rating: "safe",
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.md5).toBe("abcd");
    expect(created.rating).toBe("safe");
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await repo.count()).toBe(1);
  });

  it("defaults rating and nullable columns", async () => {
    const created = await repo.create({
      storageKey: "s",
      mimeType: "image/png",
      width: 1,
      height: 1,
      sizeBytes: 1,
      md5: "defaults",
    });

    expect(created.rating).toBe("questionable"); // schema default
    expect(created.source).toBeNull();
    expect(created.uploaderId).toBeNull();
  });

  it("lists assets newest-first", async () => {
    await repo.create(seed("first"));
    await repo.create(seed("second"));

    const rows = await repo.findMany({ limit: 10, offset: 0 });
    expect(rows.map((r) => r.md5)).toEqual(["second", "first"]);
  });

  it("honours limit and offset", async () => {
    await repo.create(seed("a"));
    await repo.create(seed("b"));
    await repo.create(seed("c"));

    const firstPage = await repo.findMany({ limit: 2, offset: 0 });
    const secondPage = await repo.findMany({ limit: 2, offset: 2 });

    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(1);
    // Newest-first (a, b, c inserted → c, b, a): exact rows catch offset bugs
    // that a mere "pages differ" check would miss.
    expect(firstPage.map((r) => r.md5)).toEqual(["c", "b"]);
    expect(secondPage.map((r) => r.md5)).toEqual(["a"]);
  });
});

/** Minimal valid asset insert keyed by a unique md5. */
function seed(md5: string) {
  return {
    storageKey: `key/${md5}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: 1,
    md5,
  };
}
