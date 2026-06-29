import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createAssetRepository, createDb, type AssetRepository, type DB } from "../src/index";

/**
 * Integration tests — they hit a real Postgres named by `DATABASE_URL` (the
 * migrations must already be applied). Skipped when it's unset so `bun test`
 * stays green on machines without a database; CI provides one and runs them.
 */
const DATABASE_URL = Bun.env.DATABASE_URL?.trim();

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
    expect(await repo.count()).toBe(1);
  });

  it("defaults rating and nullable columns", async () => {
    const created = await repo.create(seed("defaults"));

    expect(created.rating).toBe("questionable"); // schema default
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

    const rows = await repo.findMany({ limit: 10, offset: 0 });
    expect(rows.map((r) => r.storageKey)).toEqual(["key/second", "key/first"]);
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
    expect(firstPage.map((r) => r.storageKey)).toEqual(["key/c", "key/b"]);
    expect(secondPage.map((r) => r.storageKey)).toEqual(["key/a"]);
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
