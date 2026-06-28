import { describe, expect, it } from "bun:test";

import type { Asset, AssetRepository } from "@bunbooru/db";

import { createAssetService, DEFAULT_PER_PAGE, MAX_PER_PAGE } from "../src/services/asset-service";

/** Build a fixed asset with a given id; other fields are irrelevant here. */
function asset(id: number): Asset {
  return {
    id,
    storageKey: `key/${id}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: 1,
    md5: `md5-${id}`,
    rating: "questionable",
    source: null,
    uploaderId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * In-memory repository over a fixed row set — the interface is structural, so a
 * plain object satisfies it. Slices by limit/offset to mimic the SQL repo, which
 * lets us assert the service's pagination math without a database. `onFindMany`
 * captures the (limit, offset) actually sent down, so tests can prove the
 * service hands the repository clamped values — not just a normalized response.
 */
function fakeRepo(
  rows: Asset[],
  onFindMany?: (args: { limit: number; offset: number }) => void,
): AssetRepository {
  return {
    findMany: async ({ limit, offset }) => {
      onFindMany?.({ limit, offset });
      return rows.slice(offset, offset + limit);
    },
    count: async () => rows.length,
    create: async () => {
      throw new Error("not used in service tests");
    },
  };
}

const rows = Array.from({ length: 25 }, (_, i) => asset(i + 1));

describe("createAssetService.list", () => {
  it("defaults to page 1 and DEFAULT_PER_PAGE", async () => {
    const service = createAssetService(fakeRepo(rows));
    const result = await service.list();

    expect(result.page).toBe(1);
    expect(result.perPage).toBe(DEFAULT_PER_PAGE);
    expect(result.assets).toHaveLength(DEFAULT_PER_PAGE);
    expect(result.assets[0]?.id).toBe(1);
    expect(result.total).toBe(25);
    expect(result.pageCount).toBe(2); // ceil(25 / 20)
  });

  it("applies offset for later pages", async () => {
    let received: { limit: number; offset: number } | undefined;
    const service = createAssetService(
      fakeRepo(rows, (args) => {
        received = args;
      }),
    );
    const result = await service.list({ page: 2 });

    expect(result.page).toBe(2);
    expect(result.assets).toHaveLength(5); // rows 21..25
    expect(result.assets[0]?.id).toBe(21);
    expect(received).toEqual({ limit: DEFAULT_PER_PAGE, offset: 20 });
  });

  it("clamps perPage to MAX_PER_PAGE (and passes the clamped limit down)", async () => {
    let received: { limit: number; offset: number } | undefined;
    const service = createAssetService(
      fakeRepo(rows, (args) => {
        received = args;
      }),
    );
    const result = await service.list({ perPage: 500 });
    expect(result.perPage).toBe(MAX_PER_PAGE);
    expect(received).toEqual({ limit: MAX_PER_PAGE, offset: 0 });
  });

  it("falls back to defaults for non-positive or non-finite input", async () => {
    const service = createAssetService(fakeRepo(rows));

    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await service.list({ page: bad, perPage: bad });
      expect(result.page).toBe(1);
      expect(result.perPage).toBe(DEFAULT_PER_PAGE);
    }
  });

  it("floors fractional paging input", async () => {
    const service = createAssetService(fakeRepo(rows));
    const result = await service.list({ page: 2.9, perPage: 10.7 });
    expect(result.page).toBe(2);
    expect(result.perPage).toBe(10);
  });

  it("reports an empty page with pageCount 0", async () => {
    const service = createAssetService(fakeRepo([]));
    const result = await service.list();
    expect(result.assets).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pageCount).toBe(0);
  });
});
