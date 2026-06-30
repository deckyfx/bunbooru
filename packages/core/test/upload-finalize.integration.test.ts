import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import type { Asset, AssetRepository, NewAsset } from "@bunbooru/db";
import { createFilesystemStaging, createFilesystemStorageProvider } from "@bunbooru/storage";

import { UnsupportedMediaError } from "../src/errors";
import { createAssetService } from "../src/services/asset-service";

/**
 * Integration coverage for the resumable-upload finalize path against the REAL
 * filesystem staging + storage (not fakes): chunks are positional-written to a
 * staging file, then {@link AssetService.createFromSource} hashes, sniffs, and
 * stores straight from that file-backed `Bun.file()` Blob — never reading the
 * whole thing into a JS buffer. This guards the streaming wiring end-to-end
 * (incl. the `Bun.write(Blob)` store path, which a stream-wrapped variant would
 * stall on).
 */

/** A minimal in-memory {@link AssetRepository} — only what finalize touches. */
function memoryRepo(): AssetRepository {
  const rows: Asset[] = [];
  let nextId = 1;
  return {
    findMany: async () => [],
    count: async () => 0,
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
        uploaderId: input.uploaderId ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      rows.push(row);
      return row;
    },
    update: async () => null,
  };
}

// --- minimal solid-RGB PNG encoder (real bytes Bun.Image can decode) ---------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}
function solidPng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = (x * 7) & 255;
      raw[p + 1] = (y * 5) & 255;
      raw[p + 2] = 120;
    }
  }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

describe("resumable upload finalize (real filesystem)", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("stages chunks then finalizes by streaming hash/sniff/store from the file", async () => {
    root = await mkdtemp(join(tmpdir(), "bunbooru-finalize-"));
    const staging = createFilesystemStaging({ root: join(root, "staging") });
    const storage = createFilesystemStorageProvider({ root: join(root, "assets") });
    const assets = createAssetService(memoryRepo(), storage);

    const png = solidPng(400, 300);
    const referenceSha = new Bun.CryptoHasher("sha256").update(png).digest("hex");

    // Positional-write the PNG in three chunks, as the resumable PATCH flow does.
    const key = "session-token";
    const chunkSize = Math.ceil(png.byteLength / 3);
    for (let off = 0; off < png.byteLength; off += chunkSize) {
      await staging.writeChunk(key, off, png.subarray(off, Math.min(off + chunkSize, png.byteLength)));
    }

    const { asset, deduped } = await assets.createFromSource({
      kind: "file",
      path: staging.path(key),
    });

    expect(deduped).toBe(false);
    expect([asset.width, asset.height]).toEqual([400, 300]);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.sizeBytes).toBe(png.byteLength);
    // Streamed hash equals the hash over the full in-memory buffer.
    expect(asset.sha256).toBe(referenceSha);

    // The bytes round-trip exactly through the store.
    expect(await storage.exists(asset.storageKey)).toBe(true);
    const stored = new Uint8Array(
      await new Response(await storage.stream(asset.storageKey)).arrayBuffer(),
    );
    expect(stored).toEqual(new Uint8Array(png));
  });

  it("finalizes via a move (ingestLocalFile) when given the staging path, consuming the staged file", async () => {
    root = await mkdtemp(join(tmpdir(), "bunbooru-finalize-"));
    const staging = createFilesystemStaging({ root: join(root, "staging") });
    const storage = createFilesystemStorageProvider({ root: join(root, "assets") });
    const assets = createAssetService(memoryRepo(), storage);

    const png = solidPng(120, 90);
    await staging.writeChunk("mv", 0, png);
    const stagedPath = staging.path("mv");
    expect(await Bun.file(stagedPath).exists()).toBe(true);

    const { asset } = await assets.createFromSource({ kind: "file", path: stagedPath });

    // The staged file was MOVED into the store (not copied): source gone, blob present.
    expect(await Bun.file(stagedPath).exists()).toBe(false);
    expect([asset.width, asset.height]).toEqual([120, 90]);
    expect(await storage.exists(asset.storageKey)).toBe(true);
    const stored = new Uint8Array(
      await new Response(await storage.stream(asset.storageKey)).arrayBuffer(),
    );
    expect(stored).toEqual(new Uint8Array(png));
  });

  it("rejects an undecodable staged file with UnsupportedMediaError", async () => {
    root = await mkdtemp(join(tmpdir(), "bunbooru-finalize-"));
    const staging = createFilesystemStaging({ root: join(root, "staging") });
    const storage = createFilesystemStorageProvider({ root: join(root, "assets") });
    const assets = createAssetService(memoryRepo(), storage);

    await staging.writeChunk("bad", 0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await expect(
      assets.createFromSource({ kind: "file", path: staging.path("bad") }),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);
  });
});
