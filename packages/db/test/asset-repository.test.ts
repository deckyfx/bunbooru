import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAssetRepository,
  createDb,
  createTagRepository,
  type AssetOrder,
  type AssetRepository,
  type DB,
} from "../src/index";

/** The default browse order: newest (highest id) first. */
const NEWEST: AssetOrder = { kind: "column", key: "id", direction: "desc" };

/**
 * Integration tests — they hit a real Postgres (migrations must already be
 * applied) and TRUNCATE between cases, so they read a dedicated, opt-in
 * `TEST_DATABASE_URL` — never the app's `DATABASE_URL` — so a misconfigured
 * dev/prod env can't be wiped. Skipped when unset, so a bare `bun test` stays
 * green without a database; CI provides it and runs them.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!TEST_DATABASE_URL)("AssetRepository (integration)", () => {
  let db: DB;
  let repo: AssetRepository;

  beforeAll(() => {
    // Non-null: this block is skipped when TEST_DATABASE_URL is unset.
    db = createDb(TEST_DATABASE_URL as string);
    repo = createAssetRepository(db);
  });

  // Isolate every test on a clean table; CASCADE clears the asset_tags FK side.
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE assets, asset_tags RESTART IDENTITY CASCADE`);
  });

  it("starts empty", async () => {
    expect(await repo.countUpTo(undefined, 100)).toBe(0);
    expect(await repo.findPage({ order: NEWEST, limit: 10 })).toEqual([]);
  });

  it("creates an asset and reads it back", async () => {
    const input = {
      ...seed("readback"),
      storageKey: "ab/cd/abcd.png",
      width: 800,
      height: 600,
      sizeBytes: 4096,
      rating: "safe" as const,
    };
    const created = await repo.create(input);

    expect(created.id).toBeGreaterThan(0);
    expect(created.sha256).toBe(input.sha256);
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(created.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(created.rating).toBe("safe");
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await repo.countUpTo(undefined, 100)).toBe(1);
  });

  it("defaults rating and nullable columns", async () => {
    const created = await repo.create(seed("defaults"));

    expect(created.rating).toBe("unrated"); // schema default
    expect(created.source).toBeNull();
    expect(created.uploaderId).toBeNull();
  });

  it("looks up an asset by id and by sha256 (null when absent)", async () => {
    const input = seed("lookup");
    const created = await repo.create(input);

    expect((await repo.findById(created.id))?.id).toBe(created.id);
    expect((await repo.findBySha256(input.sha256))?.id).toBe(created.id);
    expect(await repo.findById(999_999)).toBeNull();
    expect(await repo.findBySha256("0".repeat(64))).toBeNull();
  });

  it("returns only the referenced subset of storage keys", async () => {
    const a = await repo.create(seed("ref-a"));
    const b = await repo.create(seed("ref-b"));

    const referenced = await repo.findReferencedStorageKeys([
      a.storageKey,
      b.storageKey,
      "key/orphan-not-stored",
    ]);

    expect(referenced).toEqual(new Set([a.storageKey, b.storageKey]));
    expect(await repo.findReferencedStorageKeys([])).toEqual(new Set());
  });

  it("rejects a duplicate sha256 (unique content key)", async () => {
    await repo.create(seed("dupe"));
    // Same sha256, different md5 — assert the *named* constraint so the test
    // fails only for the right reason, not any incidental error.
    await expectConstraint(
      repo.create({ ...seed("dupe"), md5: hexDigest("md5", "other") }),
      "assets_sha256_unique",
    );
  });

  it("rejects a negative dimension (CHECK constraint)", async () => {
    await expectConstraint(repo.create({ ...seed("neg"), width: -1 }), "assets_width_nonneg");
  });

  it("rejects a non-hex or mixed-case digest (CHECK constraint)", async () => {
    await expectConstraint(
      repo.create({ ...seed("bad"), sha256: "not-a-hex-digest" }),
      "assets_sha256_hex",
    );
    // Uppercase hex is non-canonical and must be rejected too.
    await expectConstraint(repo.create({ ...seed("upper"), md5: "A".repeat(32) }), "assets_md5_hex");
  });

  it("lists assets newest-first", async () => {
    await repo.create(seed("first"));
    await repo.create(seed("second"));

    const rows = await repo.findPage({ order: NEWEST, limit: 10 });
    expect(rows.map((r) => r.storageKey)).toEqual(["key/second", "key/first"]);
  });

  it("continues past a keyset, forward and backward", async () => {
    for (const key of ["a", "b", "c", "d"]) await repo.create(seed(key));
    const keys = (rows: { storageKey: string }[]) => rows.map((r) => r.storageKey);

    const first = await repo.findPage({ order: NEWEST, limit: 2 });
    expect(keys(first)).toEqual(["key/d", "key/c"]);
    const last = first.at(-1)!;
    const second = await repo.findPage({ order: NEWEST, limit: 2, after: { value: last.id, id: last.id } });
    expect(keys(second)).toEqual(["key/b", "key/a"]);

    // Backward from the second page's first row: the nearest newer rows first.
    const top = second[0]!;
    const back = await repo.findPage({
      order: NEWEST,
      limit: 2,
      after: { value: top.id, id: top.id },
      backward: true,
    });
    expect(keys(back)).toEqual(["key/c", "key/d"]);
  });

  it("breaks ties on the sort column by id, so no row is skipped or repeated", async () => {
    // Four posts of the same size: only the id tiebreak orders them.
    for (const key of ["a", "b", "c", "d"]) await repo.create({ ...seed(key), sizeBytes: 500 });
    const order: AssetOrder = { kind: "column", key: "sizeBytes", direction: "desc" };

    const seen: string[] = [];
    let after: { value: number | string; id: number } | undefined;
    for (;;) {
      const page = await repo.findPage({ order, limit: 3, after });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.storageKey));
      const tail = page.at(-1)!;
      after = { value: tail.sizeBytes, id: tail.id };
    }
    expect(seen).toEqual(["key/d", "key/c", "key/b", "key/a"]);
  });

  it("pages by a timestamp keyset (ISO string) in either direction", async () => {
    const at = (iso: string) => new Date(iso);
    await repo.create({ ...seed("old"), createdAt: at("2020-01-01T00:00:00.000Z") });
    await repo.create({ ...seed("mid"), createdAt: at("2022-06-15T12:00:00.000Z") });
    await repo.create({ ...seed("new"), createdAt: at("2024-12-31T23:59:59.000Z") });
    const oldestFirst: AssetOrder = { kind: "column", key: "createdAt", direction: "asc" };

    const first = await repo.findPage({ order: oldestFirst, limit: 1 });
    expect(first.map((r) => r.storageKey)).toEqual(["key/old"]);
    const cursor = { value: first[0]!.createdAt.toISOString(), id: first[0]!.id };
    const rest = await repo.findPage({ order: oldestFirst, limit: 5, after: cursor });
    expect(rest.map((r) => r.storageKey)).toEqual(["key/mid", "key/new"]);
  });

  it("pages by created_at without repeating or skipping rows at microsecond precision", async () => {
    // Default created_at = now(), stored to the microsecond. Spread them out so
    // the sub-millisecond parts differ, which a JS Date (milliseconds) loses.
    for (const key of ["a", "b", "c", "d"]) {
      await repo.create(seed(key));
      await db.execute(sql`SELECT pg_sleep(0.0004)`);
    }
    const micro = await db.execute<{ n: number | string }>(
      sql`SELECT count(*) AS n FROM assets WHERE extract(microseconds FROM created_at)::bigint % 1000 <> 0`,
    );
    expect(Number([...micro][0]?.n)).toBeGreaterThan(0); // the precision really is there

    for (const direction of ["asc", "desc"] as const) {
      const order: AssetOrder = { kind: "column", key: "createdAt", direction };
      const seen: number[] = [];
      let after: { value: string; id: number } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await repo.findPage({ order, limit: 1, after });
        if (page.length === 0) break;
        seen.push(page[0]!.id);
        after = { value: page[0]!.createdAt.toISOString(), id: page[0]!.id };
      }
      expect(seen).toEqual(direction === "asc" ? [1, 2, 3, 4] : [4, 3, 2, 1]);

      // And back again from the far end, one row at a time.
      const back: number[] = [];
      for (let guard = 0; guard < 10 && after; guard++) {
        const page = await repo.findPage({ order, limit: 1, after, backward: true });
        if (page.length === 0) break;
        back.push(page[0]!.id);
        after = { value: page[0]!.createdAt.toISOString(), id: page[0]!.id };
      }
      expect(back).toEqual(seen.slice(0, -1).reverse());
    }
  });

  it("applies the filter together with the keyset", async () => {
    for (const key of ["a", "b", "c", "d"]) {
      await repo.create({ ...seed(key), width: key === "b" ? 1 : 100 });
    }
    const wide = sql`${sql.identifier("width")} > 50`;
    const first = await repo.findPage({ where: wide, order: NEWEST, limit: 1 });
    expect(first.map((r) => r.storageKey)).toEqual(["key/d"]);
    const after = { value: first[0]!.id, id: first[0]!.id };
    const rest = await repo.findPage({ where: wide, order: NEWEST, limit: 5, after });
    expect(rest.map((r) => r.storageKey)).toEqual(["key/c", "key/a"]); // "b" filtered out
  });

  it("random order returns matching rows without a keyset", async () => {
    for (const key of ["a", "b", "c"]) await repo.create(seed(key));
    const rows = await repo.findPage({ order: { kind: "random" }, limit: 10 });
    expect(rows.map((r) => r.storageKey).sort()).toEqual(["key/a", "key/b", "key/c"]);
  });

  it("countUpTo stops at cap + 1", async () => {
    for (const key of ["a", "b", "c", "d", "e"]) await repo.create(seed(key));
    expect(await repo.countUpTo(undefined, 10)).toBe(5);
    expect(await repo.countUpTo(undefined, 3)).toBe(4); // "more than 3"
    expect(await repo.countUpTo(sql`false`, 3)).toBe(0);
  });

  it("keeps tag_count in step with the post's tags (trigger)", async () => {
    const tags = createTagRepository(db);
    await db.execute(sql`TRUNCATE TABLE tags RESTART IDENTITY CASCADE`);
    const asset = await repo.create(seed("tagged"));
    const rows = await tags.getOrCreateByNames(["a", "b", "c"]);
    const ids = rows.map((t) => t.id);

    await tags.setAssetTags(asset.id, ids, null);
    expect((await repo.findById(asset.id))?.tagCount).toBe(3);
    await tags.setAssetTags(asset.id, ids.slice(0, 1), null);
    expect((await repo.findById(asset.id))?.tagCount).toBe(1);
  });

  it("neighbors returns adjacent ids in the newest-first browse order", async () => {
    // Ascending ids 1,2,3 → browse order (desc) is 3,2,1. `newerId` is the post
    // shown just BEFORE this one (higher id); `olderId` the one just after.
    const a1 = await repo.create(seed("n1"));
    const a2 = await repo.create(seed("n2"));
    const a3 = await repo.create(seed("n3"));

    expect(await repo.neighbors(a2.id)).toEqual({ newerId: a3.id, olderId: a1.id });
    // Ends: newest has no newer, oldest has no older.
    expect(await repo.neighbors(a3.id)).toEqual({ newerId: null, olderId: a2.id });
    expect(await repo.neighbors(a1.id)).toEqual({ newerId: a2.id, olderId: null });
    // A non-existent id still resolves positionally (both neighbors of a gap).
    expect(await repo.neighbors(9999)).toEqual({ newerId: null, olderId: a3.id });
  });
});

/** Bun's Postgres driver puts the violated constraint name on `error.cause`. */
interface PgCause {
  constraint?: string;
}

/**
 * Assert an insert rejects by violating a *specific* named DB constraint, read
 * from `error.cause.constraint` (the wrapped Drizzle message omits it). Matching
 * the name keeps the test tied to the schema contract instead of passing on any
 * incidental error.
 */
async function expectConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: PgCause }).cause;
    expect(cause?.constraint).toBe(constraint);
    return;
  }
  throw new Error(`expected a "${constraint}" violation, but the insert resolved`);
}

/** Canonical lowercase-hex digest, satisfying the schema's hex CHECK constraints. */
function hexDigest(algo: "sha256" | "md5", input: string): string {
  return new Bun.CryptoHasher(algo).update(input).digest("hex");
}

/**
 * Minimal valid asset insert keyed by `key`. `storageKey` stays human-readable
 * for ordering assertions; `sha256`/`md5` are real canonical digests so they
 * pass the schema's hex CHECK (and are unique per key).
 */
function seed(key: string) {
  return {
    storageKey: `key/${key}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: 1,
    sha256: hexDigest("sha256", `sha:${key}`),
    md5: hexDigest("md5", `md5:${key}`),
  };
}
