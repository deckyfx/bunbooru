import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAssetRepository,
  createDb,
  createTagAliasRepository,
  createTagRepository,
  type AssetRepository,
  type DB,
  type NewAsset,
} from "@bunbooru/db";
import type { StorageProvider } from "@bunbooru/storage";

import { createAssetService, type AssetService } from "../src/services/asset-service";

/**
 * Integration tests for the Search Engine (AST → SQL). They hit a real Postgres
 * and TRUNCATE between cases, so they read a dedicated, opt-in `TEST_DATABASE_URL`
 * — never the app's `DATABASE_URL` — so a misconfigured dev/prod env can't be
 * wiped. Skipped when unset, keeping a bare `bun test` green without a database.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

/** `list` never touches storage, so a throwing stub is fine here. */
const noopStorage: StorageProvider = {
  store: async () => undefined,
  delete: async () => undefined,
  exists: async () => false,
  statModifiedAt: async () => null,
  list: async function* () {
    throw new Error("unused");
  },
  stream: async () => {
    throw new Error("unused");
  },
  copy: async () => undefined,
  move: async () => undefined,
  getPublicUrl: async () => null,
};

const hex = (algo: "sha256" | "md5", s: string) =>
  new Bun.CryptoHasher(algo).update(s).digest("hex");

function asset(key: string, over: Partial<NewAsset>): NewAsset {
  return {
    storageKey: `k/${key}`,
    mimeType: "image/png",
    width: 100,
    height: 100,
    sizeBytes: 1,
    sha256: hex("sha256", key),
    md5: hex("md5", key),
    ...over,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("Search execution (integration)", () => {
  let db: DB;
  let repo: AssetRepository;
  let service: AssetService;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    repo = createAssetRepository(db);
    service = createAssetService(repo, noopStorage);
  });

  // Three assets: a(safe,1920×1080) b(explicit,500×800) c(safe,800×600).
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE assets, asset_tags RESTART IDENTITY CASCADE`);
    await repo.create(asset("a", { rating: "safe", width: 1920, height: 1080 }));
    await repo.create(asset("b", { rating: "explicit", width: 500, height: 800 }));
    await repo.create(asset("c", { rating: "safe", width: 800, height: 600 }));
  });

  /** Sorted storage keys of a result page, for set comparison. */
  const keys = (p: { assets: Array<{ storageKey: string }> }) =>
    p.assets.map((a) => a.storageKey).sort();

  it("returns everything for an empty query", async () => {
    const r = await service.list({});
    expect(r.total).toBe(3);
  });

  it("filters by rating (enum equality)", async () => {
    const r = await service.list({ query: "rating:safe" });
    expect(r.total).toBe(2);
    expect(keys(r)).toEqual(["k/a", "k/c"]);
  });

  it("filters by numeric comparison", async () => {
    expect(keys(await service.list({ query: "width:>1000" }))).toEqual(["k/a"]);
    expect(keys(await service.list({ query: "height:<=800" }))).toEqual(["k/b", "k/c"]);
  });

  it("ANDs multiple metatags", async () => {
    const r = await service.list({ query: "rating:safe width:>=800" });
    expect(keys(r)).toEqual(["k/a", "k/c"]);
  });

  it("supports numeric ranges", async () => {
    expect(keys(await service.list({ query: "width:600..900" }))).toEqual(["k/c"]);
    expect(keys(await service.list({ query: "width:..600" }))).toEqual(["k/b"]);
  });

  it("ignores a malformed multi-bound range (not silently truncated)", async () => {
    // `1..2..3` is invalid syntax: the term is dropped, not compiled to 1..2.
    expect((await service.list({ query: "width:1..2..3" })).total).toBe(3);
  });

  it("negates a term", async () => {
    expect(keys(await service.list({ query: "-rating:safe" }))).toEqual(["k/b"]);
  });

  it("compiles tag terms but matches nothing until tags exist", async () => {
    expect((await service.list({ query: "1girl" })).total).toBe(0);
  });

  it("reflects the filter in pagination metadata", async () => {
    const r = await service.list({ query: "rating:safe", perPage: 1 });
    expect(r.total).toBe(2);
    expect(r.pageCount).toBe(2);
    expect(r.assets).toHaveLength(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Search with aliases (integration)", () => {
  let db: DB;
  let repo: AssetRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    repo = createAssetRepository(db);
  });

  // a: cat (once aliased from kitty), b: dog.
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, tag_aliases RESTART IDENTITY CASCADE`,
    );
    const tags = createTagRepository(db);
    const a = await repo.create(asset("a", {}));
    const b = await repo.create(asset("b", {}));
    const [kitty] = await tags.getOrCreateByNames(["kitty"]);
    const [dog] = await tags.getOrCreateByNames(["dog"]);
    await tags.setAssetTags(a.id, [kitty!.id], null);
    await tags.setAssetTags(b.id, [dog!.id], null);
    await createTagAliasRepository(db).create({
      antecedentName: "kitty",
      consequentName: "cat",
      creatorId: null,
    });
  });

  const keys = (p: { assets: Array<{ storageKey: string }> }) =>
    p.assets.map((x) => x.storageKey).sort();
  const aliasAware = () =>
    createAssetService(repo, noopStorage, undefined, (names) =>
      createTagAliasRepository(db).resolve(names),
    );

  it("finds posts by the alias antecedent, which no post carries any more", async () => {
    expect(keys(await aliasAware().list({ query: "kitty" }))).toEqual(["k/a"]);
    expect(keys(await aliasAware().list({ query: "cat" }))).toEqual(["k/a"]);
  });

  it("applies the alias inside a negation and alongside its consequent", async () => {
    expect(keys(await aliasAware().list({ query: "-kitty" }))).toEqual(["k/b"]);
    expect(keys(await aliasAware().list({ query: "kitty cat" }))).toEqual(["k/a"]);
  });

  it("without a resolver, the antecedent matches nothing (it was migrated away)", async () => {
    expect((await createAssetService(repo, noopStorage).list({ query: "kitty" })).total).toBe(0);
  });
});
