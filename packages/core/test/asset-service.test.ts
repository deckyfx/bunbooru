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
    viewCount: 0,
    uploaderId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * In-memory repository mirroring the real one's **newest-first** ordering
 * (`order by id desc`), so the pagination assertions validate the same order
 * production returns — without a database.
 */
function fakeRepo(initial: Asset[] = []): AssetRepository {
  const rows = [...initial];
  let nextId = (rows.at(-1)?.id ?? 0) + 1;
  return {
    findMany: async ({ limit, offset }) =>
      [...rows].sort((a, b) => b.id - a.id).slice(offset, offset + limit),
    count: async () => rows.length,
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findBySha256: async (sha256) => rows.find((r) => r.sha256 === sha256) ?? null,
    findReferencedStorageKeys: async (keys) =>
      new Set(rows.filter((r) => keys.includes(r.storageKey)).map((r) => r.storageKey)),
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
        rating: input.rating ?? "unrated",
        source: input.source ?? null,
        viewCount: 0,
        uploaderId: input.uploaderId ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      rows.push(row);
      return row;
    },
    update: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      // Mirror the real repo: every update bumps updatedAt.
      Object.assign(row, patch, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
      return row;
    },
  };
}

/** In-memory storage provider that records what was stored (+ a modified time). */
function fakeStorage(): {
  provider: StorageProvider;
  stored: Map<string, Uint8Array>;
  setModifiedAt: (key: string, at: Date) => void;
  ingestCalls: { localPath: string; key: string }[];
} {
  const stored = new Map<string, Uint8Array>();
  const modified = new Map<string, Date>();
  const ingestCalls: { localPath: string; key: string }[] = [];
  const provider: StorageProvider = {
    store: async (key, data) => {
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
      stored.set(key, bytes);
      modified.set(key, new Date(0));
    },
    delete: async (key) => {
      stored.delete(key);
      modified.delete(key);
    },
    exists: async (key) => stored.has(key),
    statModifiedAt: async (key) => (stored.has(key) ? (modified.get(key) ?? new Date(0)) : null),
    list: async function* (prefix = "") {
      for (const key of stored.keys()) {
        if (key.startsWith(prefix)) yield { key, modifiedAt: modified.get(key) ?? new Date(0) };
      }
    },
    stream: async (key) => {
      const bytes = stored.get(key);
      if (!bytes) throw new Error(`not found: ${key}`);
      const body = new Response(bytes).body;
      if (!body) throw new Error("no body");
      return body;
    },
    copy: async () => undefined,
    move: async () => undefined,
    ingestLocalFile: async (localPath, key) => {
      // Simulate a move: the source is "consumed" and lands at `key`.
      ingestCalls.push({ localPath, key });
      stored.set(key, new Uint8Array());
      modified.set(key, new Date(0));
    },
    getPublicUrl: async () => null,
  };
  const setModifiedAt = (key: string, at: Date): void => {
    modified.set(key, at);
  };
  return { provider, stored, setModifiedAt, ingestCalls };
}

const rows = Array.from({ length: 25 }, (_, i) => asset(i + 1));

describe("createAssetService.list", () => {
  const service = () => createAssetService(fakeRepo(rows), fakeStorage().provider);

  it("defaults to page 1 and DEFAULT_PER_PAGE (newest-first)", async () => {
    const result = await service().list();
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(DEFAULT_PER_PAGE);
    expect(result.assets).toHaveLength(DEFAULT_PER_PAGE);
    expect(result.assets[0]?.id).toBe(25); // highest id first
    expect(result.total).toBe(25);
    expect(result.pageCount).toBe(2);
  });

  it("applies offset for later pages", async () => {
    const result = await service().list({ page: 2 });
    expect(result.page).toBe(2);
    expect(result.assets).toHaveLength(5);
    expect(result.assets[0]?.id).toBe(5); // ids 5..1 on the last page
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

describe("createAssetService.createFromSource (streaming)", () => {
  it("produces identical hashes/metadata/key as the in-memory create path", async () => {
    // Same content through both entry points must yield the same asset — proving
    // the streaming hash/sniff/store pipeline matches the in-memory one.
    const viaBytes = await createAssetService(fakeRepo(), fakeStorage().provider).create({
      bytes: PNG_1x1,
    });
    // A multi-part Blob forces the source to stream in more than one chunk.
    const split = Math.floor(PNG_1x1.byteLength / 2);
    const blob = new Blob([PNG_1x1.subarray(0, split), PNG_1x1.subarray(split)]);
    const { provider, stored } = fakeStorage();
    const viaSource = await createAssetService(fakeRepo(), provider).createFromSource({
      kind: "blob",
      blob,
    });

    expect(viaSource.deduped).toBe(false);
    expect(viaSource.asset.sha256).toBe(viaBytes.asset.sha256);
    expect(viaSource.asset.md5).toBe(viaBytes.asset.md5);
    expect(viaSource.asset.width).toBe(1);
    expect(viaSource.asset.height).toBe(1);
    expect(viaSource.asset.mimeType).toBe("image/png");
    expect(viaSource.asset.sizeBytes).toBe(PNG_1x1.byteLength);
    expect(viaSource.asset.storageKey).toBe(viaBytes.asset.storageKey);
    // The stored bytes round-trip exactly through the streamed store.
    expect(stored.get(viaSource.asset.storageKey)).toEqual(PNG_1x1);
  });

  it("dedupes a source whose content already exists", async () => {
    const { provider } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);
    const first = await service.create({ bytes: PNG_1x1 });
    const second = await service.createFromSource({ kind: "blob", blob: new Blob([PNG_1x1]) });
    expect(second.deduped).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
  });

  it("rejects a non-image source with UnsupportedMediaError", async () => {
    const service = createAssetService(fakeRepo(), fakeStorage().provider);
    await expect(
      service.createFromSource({ kind: "blob", blob: new Blob([new Uint8Array([1, 2, 3, 4])]) }),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);
  });

  it("copies (does not move) a blob source — ingestLocalFile is only for files", async () => {
    const { provider, ingestCalls, stored } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);

    const { asset } = await service.createFromSource({ kind: "blob", blob: new Blob([PNG_1x1]) });

    // A blob source is always stored (copied); the move fast path is reserved
    // for `file` sources (covered end-to-end in the finalize integration test).
    expect(ingestCalls).toHaveLength(0);
    expect(stored.has(asset.storageKey)).toBe(true);
  });
});

describe("createAssetService.gcOrphanedBlobs", () => {
  it("removes old unreferenced blobs, keeps referenced and recent ones", async () => {
    const { provider, stored, setModifiedAt } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);

    // A real, referenced asset (stored under assets/.. with a row).
    const { asset } = await service.create({ bytes: PNG_1x1 });
    // An old orphan (no row) and a recent orphan (no row, inside the grace window).
    stored.set("assets/zz/old-orphan", new Uint8Array([1]));
    setModifiedAt("assets/zz/old-orphan", new Date(0));
    stored.set("assets/zz/new-orphan", new Uint8Array([2]));
    setModifiedAt("assets/zz/new-orphan", new Date(Date.now()));

    const removed = await service.gcOrphanedBlobs(new Date(Date.now() - 60_000));

    expect(removed).toBe(1);
    expect(stored.has("assets/zz/old-orphan")).toBe(false); // reclaimed
    expect(stored.has("assets/zz/new-orphan")).toBe(true); // protected by grace
    expect(stored.has(asset.storageKey)).toBe(true); // referenced, kept regardless of age
  });

  it("sweeps a backlog larger than the batch size", async () => {
    const { provider, stored, setModifiedAt } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);
    for (let i = 0; i < 3; i++) {
      stored.set(`assets/x/${i}`, new Uint8Array([i]));
      setModifiedAt(`assets/x/${i}`, new Date(0));
    }

    const removed = await service.gcOrphanedBlobs(new Date(Date.now() - 1000), 2);

    expect(removed).toBe(3);
    expect(stored.size).toBe(0);
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

  it("openFile returns null when the row outlived its blob", async () => {
    const { provider, stored } = fakeStorage();
    const service = createAssetService(fakeRepo(), provider);
    const { asset } = await service.create({ bytes: PNG_1x1 });

    stored.clear(); // blob deleted out from under the DB row
    expect(await service.openFile(asset.id)).toBeNull();
  });
});
