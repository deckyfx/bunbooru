import { describe, expect, it } from "bun:test";

import type { Asset, AssetRepository, NewAsset } from "@bunbooru/db";
import type { StorageProvider } from "@bunbooru/storage";

import { UnsupportedMediaError } from "../src/errors";
import { createAssetService, DEFAULT_PER_PAGE, MAX_PER_PAGE } from "../src/services/asset-service";

/** A valid 1×1 PNG so `Bun.Image.metadata()` returns real width/height/format. */
const PNG_1x1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A fixed asset with a given id; other fields are irrelevant to list math. */
function asset(id: number): Asset {
  return {
    id,
    storageKey: `assets/key/${id}`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: 1,
    sha256: String(id).padStart(64, "0"),
    md5: String(id).padStart(32, "0"),
    rating: "questionable",
    source: null,
    uploaderId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * In-memory repository — insertion order preserved (the real one orders/queries
 * in SQL), so `findMany` slices like the SQL `limit/offset` and lets us assert
 * the service's pagination math without a database.
 */
function fakeRepo(initial: Asset[] = []): AssetRepository {
  const rows = [...initial];
  let nextId = (rows.at(-1)?.id ?? 0) + 1;
  return {
    findMany: async ({ limit, offset }) => rows.slice(offset, offset + limit),
    count: async () => rows.length,
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findBySha256: async (sha256) => rows.find((r) => r.sha256 === sha256) ?? null,
    create: async (input: NewAsset) => {
      const row: Asset = {
        id: nextId++,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        md5: input.md5,
        rating: input.rating ?? "questionable",
        source: input.source ?? null,
        uploaderId: input.uploaderId ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      rows.push(row);
      return row;
    },
  };
}

/** In-memory storage provider that records what was stored. */
function fakeStorage(): { provider: StorageProvider; stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const provider: StorageProvider = {
    store: async (key, data) => {
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
      stored.set(key, bytes);
    },
    delete: async (key) => {
      stored.delete(key);
    },
    exists: async (key) => stored.has(key),
    stream: async (key) => {
      const bytes = stored.get(key);
      if (!bytes) throw new Error(`not found: ${key}`);
      const body = new Response(bytes).body;
      if (!body) throw new Error("no body");
      return body;
    },
    copy: async () => undefined,
    move: async () => undefined,
    getPublicUrl: async () => null,
  };
  return { provider, stored };
}

const rows = Array.from({ length: 25 }, (_, i) => asset(i + 1));

describe("createAssetService.list", () => {
  const service = () => createAssetService(fakeRepo(rows), fakeStorage().provider);

  it("defaults to page 1 and DEFAULT_PER_PAGE", async () => {
    const result = await service().list();
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(DEFAULT_PER_PAGE);
    expect(result.assets).toHaveLength(DEFAULT_PER_PAGE);
    expect(result.assets[0]?.id).toBe(1);
    expect(result.total).toBe(25);
    expect(result.pageCount).toBe(2);
  });

  it("applies offset for later pages", async () => {
    const result = await service().list({ page: 2 });
    expect(result.page).toBe(2);
    expect(result.assets).toHaveLength(5);
    expect(result.assets[0]?.id).toBe(21);
  });

  it("clamps perPage to MAX_PER_PAGE", async () => {
    const result = await service().list({ perPage: 500 });
    expect(result.perPage).toBe(MAX_PER_PAGE);
  });

  it("falls back to defaults for non-positive or non-finite input", async () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await service().list({ page: bad, perPage: bad });
      expect(result.page).toBe(1);
      expect(result.perPage).toBe(DEFAULT_PER_PAGE);
    }
  });

  it("reports an empty page with pageCount 0", async () => {
    const result = await createAssetService(fakeRepo([]), fakeStorage().provider).list();
    expect(result.assets).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pageCount).toBe(0);
  });
});

describe("createAssetService.create (upload)", () => {
  it("hashes, sniffs dimensions, stores the bytes, and persists the asset", async () => {
    const { provider, stored } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);

    const { asset, deduped } = await service.create({ bytes: PNG_1x1 });

    expect(deduped).toBe(false);
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.sizeBytes).toBe(PNG_1x1.byteLength);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(asset.storageKey).toContain(asset.sha256);
    expect(stored.has(asset.storageKey)).toBe(true);
  });

  it("dedupes an identical re-upload without storing again", async () => {
    const { provider, stored } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);

    const first = await service.create({ bytes: PNG_1x1 });
    const storedAfterFirst = stored.size;
    const second = await service.create({ bytes: PNG_1x1 });

    expect(second.deduped).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(stored.size).toBe(storedAfterFirst); // no second write
  });

  it("rejects non-image bytes with UnsupportedMediaError", async () => {
    const service = createAssetService(fakeRepo(), fakeStorage().provider);
    await expect(service.create({ bytes: new Uint8Array([1, 2, 3, 4]) })).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
  });
});

describe("createAssetService.getById / openFile", () => {
  it("getById returns the asset or null", async () => {
    const service = createAssetService(fakeRepo([asset(7)]), fakeStorage().provider);
    expect((await service.getById(7))?.id).toBe(7);
    expect(await service.getById(99)).toBeNull();
  });

  it("openFile streams back the stored bytes, or null when absent", async () => {
    const { provider } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);
    const { asset } = await service.create({ bytes: PNG_1x1 });

    const file = await service.openFile(asset.id);
    expect(file?.mimeType).toBe("image/png");
    const back = new Uint8Array(await new Response(file?.stream).arrayBuffer());
    expect(back).toEqual(PNG_1x1);

    expect(await service.openFile(9999)).toBeNull();
  });
});
