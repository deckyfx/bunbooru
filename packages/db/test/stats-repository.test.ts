import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAssetRepository,
  createDb,
  createStatsRepository,
  type AssetRepository,
  type DB,
  type StatsRepository,
} from "../src/index";

/**
 * Integration tests against a real Postgres (opt-in `TEST_DATABASE_URL`). These
 * lock down the traffic counters: the per-visitor view debounce (and its
 * `assets.view_count` bump), daily-unique-visitor idempotency, and the totals.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

function digest(key: string, len: number): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, len);
}

const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)("StatsRepository (integration)", () => {
  let db: DB;
  let stats: StatsRepository;
  let assets: AssetRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    stats = createStatsRepository(db);
    assets = createAssetRepository(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE assets, post_views, daily_visitors RESTART IDENTITY CASCADE`,
    );
  });

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

  const viewCountOf = async (id: number): Promise<number> =>
    (await assets.findById(id))?.viewCount ?? -1;

  it("counts the first view and bumps view_count, debouncing a repeat in the window", async () => {
    const id = await seedAsset("a");

    expect(await stats.recordView("v1", id, HOUR)).toBe(true);
    expect(await viewCountOf(id)).toBe(1);

    // Same visitor within the window → not counted.
    expect(await stats.recordView("v1", id, HOUR)).toBe(false);
    expect(await viewCountOf(id)).toBe(1);

    // A different visitor → counted.
    expect(await stats.recordView("v2", id, HOUR)).toBe(true);
    expect(await viewCountOf(id)).toBe(2);
  });

  it("counts again once the session window has elapsed", async () => {
    const id = await seedAsset("a");
    expect(await stats.recordView("v1", id, HOUR)).toBe(true);

    // A 0ms window means the prior count (in the past) is already older than the
    // cutoff, so the same visitor counts again.
    expect(await stats.recordView("v1", id, 0)).toBe(true);
    expect(await viewCountOf(id)).toBe(2);
  });

  it("counts daily unique visitors idempotently", async () => {
    await stats.recordVisit("v1", "2026-03-15");
    await stats.recordVisit("v1", "2026-03-15"); // repeat same day → no-op
    await stats.recordVisit("v2", "2026-03-15");
    await stats.recordVisit("v1", "2026-03-16"); // next day → separate bucket

    expect(await stats.visitorCount("2026-03-15")).toBe(2);
    expect(await stats.visitorCount("2026-03-16")).toBe(1);
    expect(await stats.visitorCount("2026-03-17")).toBe(0);
  });

  it("reports the total post count", async () => {
    expect(await stats.postCount()).toBe(0);
    await seedAsset("a");
    await seedAsset("b");
    expect(await stats.postCount()).toBe(2);
  });
});
