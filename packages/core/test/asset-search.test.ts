import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAssetRepository,
  createDb,
  createTagAliasRepository,
  createTagRepository,
  createUserRepository,
  type AssetRepository,
  type DB,
  type NewAsset,
} from "@bunbooru/db";
import type { StorageProvider } from "@bunbooru/storage";

import { createSearchProviderRegistry, type SearchProvider } from "../src/search/providers";
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

  it("reflects the filter in pagination metadata, and pages through it", async () => {
    const r = await service.list({ query: "rating:safe", perPage: 1 });
    expect(r.total).toBe(2);
    expect(r.assets).toHaveLength(1);
    const next = await service.list({ query: "rating:safe", perPage: 1, cursor: r.nextCursor! });
    expect(next.assets).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(keys(r).concat(keys(next)).sort()).toEqual(["k/a", "k/c"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Search metatags and order: (integration)", () => {
  let db: DB;
  let repo: AssetRepository;
  let service: AssetService;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    repo = createAssetRepository(db);
    service = createAssetService(repo, noopStorage);
  });

  // a: alice, 2024-01-10, 3 KB, 1 tag, 9 views
  // b: bob,   2025-06-01, 1 KB, 3 tags, 2 views
  // c: alice, 2026-10-15, 2 KB, 0 tags, 5 views
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users RESTART IDENTITY CASCADE`,
    );
    const users = createUserRepository(db);
    const alice = await users.create({ username: "alice", email: null, passwordHash: "x", role: "member" });
    const bob = await users.create({ username: "bob", email: null, passwordHash: "x", role: "member" });
    const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
    const a = await repo.create(asset("a", { uploaderId: alice.id, createdAt: at("2024-01-10"), sizeBytes: 3000 }));
    const b = await repo.create(asset("b", { uploaderId: bob.id, createdAt: at("2025-06-01"), sizeBytes: 1000 }));
    await repo.create(asset("c", { uploaderId: alice.id, createdAt: at("2026-10-15"), sizeBytes: 2000 }));
    const tags = createTagRepository(db);
    const rows = await tags.getOrCreateByNames(["x", "y", "z"]);
    await tags.setAssetTags(a.id, [rows[0]!.id], null);
    await tags.setAssetTags(b.id, rows.map((t) => t.id), null);
    for (const [key, views] of [["k/a", 9], ["k/b", 2], ["k/c", 5]] as const) {
      await db.execute(sql`UPDATE assets SET view_count = ${views} WHERE storage_key = ${key}`);
    }
  });

  const keys = (p: { assets: Array<{ storageKey: string }> }) =>
    p.assets.map((x) => x.storageKey).sort();
  const ordered = (p: { assets: Array<{ storageKey: string }> }) => p.assets.map((x) => x.storageKey);
  const find = (query: string) => service.list({ query });

  it("id:, views:, tagcount: compare numerically", async () => {
    expect(keys(await find("id:2"))).toEqual(["k/b"]);
    expect(keys(await find("id:>=2"))).toEqual(["k/b", "k/c"]);
    expect(keys(await find("views:>4"))).toEqual(["k/a", "k/c"]);
    expect(keys(await find("tagcount:0"))).toEqual(["k/c"]);
    expect(keys(await find("tagcount:1..3"))).toEqual(["k/a", "k/b"]);
  });

  it("md5: matches the exact digest, case-insensitively; a malformed one is ignored", async () => {
    const md5 = hex("md5", "b");
    expect(keys(await find(`md5:${md5}`))).toEqual(["k/b"]);
    expect(keys(await find(`md5:${md5.toUpperCase()}`))).toEqual(["k/b"]);
    expect((await find("md5:nothex")).total).toBe(3); // ignored, not "match nothing"
  });

  it("user: filters by uploader; an unknown user matches nothing", async () => {
    expect(keys(await find("user:alice"))).toEqual(["k/a", "k/c"]);
    expect(keys(await find("user:BOB"))).toEqual(["k/b"]);
    expect((await find("user:nobody")).total).toBe(0);
    expect(keys(await find("-user:alice"))).toEqual(["k/b"]);
    // Matched case-insensitively even against a name stored in mixed case (the
    // auth service lowercases, but the filter mustn't depend on that).
    const carol = await createUserRepository(db).create({
      username: "Carol",
      email: null,
      passwordHash: "x",
      role: "member",
    });
    await repo.create(asset("carol", { uploaderId: carol.id }));
    expect(keys(await find("user:carol"))).toEqual(["k/carol"]);
    expect(keys(await find("user:CAROL"))).toEqual(["k/carol"]);
    // A post with no uploader (deleted account) is "not by alice", too.
    await repo.create(asset("orphan", { uploaderId: null }));
    expect(keys(await find("-user:alice"))).toEqual(["k/b", "k/carol", "k/orphan"]);
  });

  it("date: selects whole UTC days, comparisons and ranges", async () => {
    expect(keys(await find("date:2025-06-01"))).toEqual(["k/b"]);
    expect(keys(await find("date:>2025-06-01"))).toEqual(["k/c"]);
    expect(keys(await find("date:<=2025-06-01"))).toEqual(["k/a", "k/b"]);
    expect(keys(await find("date:2024-01-01..2025-12-31"))).toEqual(["k/a", "k/b"]);
    expect((await find("date:2026-02-30")).total).toBe(3); // impossible date → ignored
  });

  it("order: sorts by the named key, either way", async () => {
    expect(ordered(await find("order:size"))).toEqual(["k/a", "k/c", "k/b"]);
    expect(ordered(await find("order:size_asc"))).toEqual(["k/b", "k/c", "k/a"]);
    expect(ordered(await find("order:views"))).toEqual(["k/a", "k/c", "k/b"]);
    expect(ordered(await find("order:tagcount"))).toEqual(["k/b", "k/a", "k/c"]);
    expect(ordered(await find("order:date_asc"))).toEqual(["k/a", "k/b", "k/c"]);
    expect(ordered(await find("order:id"))).toEqual(["k/a", "k/b", "k/c"]);
  });

  it("order: combines with filters, and only a positive top-level one counts", async () => {
    expect(ordered(await find("user:alice order:size_asc"))).toEqual(["k/c", "k/a"]);
    // Negated or inside an OR group: not a sort, not a filter.
    expect(ordered(await find("-order:size_asc"))).toEqual(["k/c", "k/b", "k/a"]);
    expect(ordered(await find("order:views order:size_asc"))).toEqual(["k/b", "k/c", "k/a"]); // last wins
  });

  it("pages through a non-id order with cursors", async () => {
    const first = await service.list({ query: "order:size", perPage: 2 });
    expect(ordered(first)).toEqual(["k/a", "k/c"]);
    const second = await service.list({ query: "order:size", perPage: 2, cursor: first.nextCursor! });
    expect(ordered(second)).toEqual(["k/b"]);
    const back = await service.list({ query: "order:size", perPage: 2, cursor: second.prevCursor! });
    expect(ordered(back)).toEqual(["k/a", "k/c"]);
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
    createAssetService(repo, noopStorage, undefined, {
      resolveAliases: (names) => createTagAliasRepository(db).resolve(names),
    });

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

describe.skipIf(!TEST_DATABASE_URL)("Search with plugin metatags (integration)", () => {
  let db: DB;
  let repo: AssetRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    repo = createAssetRepository(db);
  });

  // Three posts; the fake provider's `pick:N` matches the post whose id is N.
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE assets, asset_tags RESTART IDENTITY CASCADE`);
    for (const key of ["a", "b", "c"]) await repo.create(asset(key, { rating: key === "c" ? "explicit" : "safe" }));
  });

  const keys = (p: { assets: Array<{ storageKey: string }> }) => p.assets.map((x) => x.storageKey).sort();

  function serviceWith(compile: SearchProvider["compile"]) {
    const providers = createSearchProviderRegistry();
    providers.register("test-plugin", [{ key: "pick", compile }]);
    return createAssetService(repo, noopStorage, undefined, { providers });
  }
  const pick: SearchProvider["compile"] = ({ op, value }, asset) =>
    op === "eq" && /^\d+$/.test(value) ? sql`${asset.id} = ${Number(value)}` : undefined;

  it("composes a plugin metatag with Core terms, OR groups and negation", async () => {
    const svc = serviceWith(pick);
    expect(keys(await svc.list({ query: "pick:2" }))).toEqual(["k/b"]);
    expect(keys(await svc.list({ query: "~pick:1 ~pick:3" }))).toEqual(["k/a", "k/c"]);
    expect(keys(await svc.list({ query: "-pick:1" }))).toEqual(["k/b", "k/c"]);
    expect(keys(await svc.list({ query: "rating:safe -pick:2" }))).toEqual(["k/a"]);
  });

  it("ignores a term the provider can't understand, like an unknown Core term", async () => {
    expect((await serviceWith(pick).list({ query: "pick:nope" })).total).toBe(3);
  });

  it("ignores a blank plugin term without asking the provider, like a blank Core term", async () => {
    let calls = 0;
    const svc = serviceWith((term, asset) => {
      calls += 1;
      return pick(term, asset);
    });
    expect((await svc.list({ query: "pick:" })).total).toBe(3);
    expect((await svc.list({ query: "-pick:" })).total).toBe(3);
    expect(calls).toBe(0);
  });

  it("compiles each distinct term once, even when repeated", async () => {
    let calls = 0;
    const svc = serviceWith((term, asset) => {
      calls += 1;
      return pick(term, asset);
    });
    await svc.list({ query: "pick:2 ~pick:2 ~pick:3 -pick:2" });
    expect(calls).toBe(2); // pick:2 and pick:3
  });

  it("ignores the key entirely when no plugin provides it (plugin inactive)", async () => {
    const svc = createAssetService(repo, noopStorage, undefined, { providers: createSearchProviderRegistry() });
    expect((await svc.list({ query: "pick:2" })).total).toBe(3);
  });

  it("fails the search when a provider throws, rather than silently widening it", async () => {
    const svc = serviceWith(() => {
      throw new Error("provider broke");
    });
    await expect(svc.list({ query: "pick:1" })).rejects.toThrow("provider broke");
  });
});
