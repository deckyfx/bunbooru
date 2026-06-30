import { describe, expect, it } from "bun:test";

import type {
  Asset,
  NewUploadSession,
  UploadSession,
  UploadSessionRepository,
} from "@bunbooru/db";
import type { StagingStore } from "@bunbooru/storage";

import { UnsupportedMediaError, UploadConflictError } from "../src/errors";
import type { AssetService } from "../src/services/asset-service";
import { createUploadService } from "../src/services/upload-service";

/** A finalized asset the fake pipeline returns on success. */
const sampleAsset: Asset = {
  id: 1,
  storageKey: "assets/ab/abcd",
  mimeType: "image/png",
  width: 1,
  height: 1,
  sizeBytes: 4,
  sha256: "a".repeat(64),
  md5: "b".repeat(32),
  rating: "unrated",
  source: null,
  uploaderId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/**
 * In-memory {@link UploadSessionRepository} with a real compare-and-swap on
 * `setOffset`, so concurrency assertions exercise the same advance-once
 * semantics the Postgres CAS provides — without a database.
 */
function fakeSessions(initial?: Partial<UploadSession>): {
  repo: UploadSessionRepository;
  get: (token: string) => UploadSession | undefined;
} {
  const rows = new Map<string, UploadSession>();
  if (initial?.token) {
    rows.set(initial.token, {
      id: 1,
      token: initial.token,
      filename: initial.filename ?? "f.png",
      mimeType: initial.mimeType ?? null,
      declaredSize: initial.declaredSize ?? 4,
      uploadedSize: initial.uploadedSize ?? 0,
      stagingKey: initial.stagingKey ?? initial.token,
      uploaderId: initial.uploaderId ?? null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
  let nextId = rows.size + 1;
  return {
    get: (token) => rows.get(token),
    repo: {
      create: async (input: NewUploadSession) => {
        const row: UploadSession = {
          id: nextId++,
          token: input.token,
          filename: input.filename,
          mimeType: input.mimeType ?? null,
          declaredSize: input.declaredSize,
          uploadedSize: input.uploadedSize ?? 0,
          stagingKey: input.stagingKey,
          uploaderId: input.uploaderId ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          expiresAt: input.expiresAt,
        };
        rows.set(row.token, row);
        return row;
      },
      findByToken: async (token) => rows.get(token) ?? null,
      setOffset: async (token, expected, uploadedSize) => {
        const row = rows.get(token);
        if (!row || row.uploadedSize !== expected) return null; // CAS miss
        const next = { ...row, uploadedSize };
        rows.set(token, next);
        return next;
      },
      delete: async (token) => {
        rows.delete(token);
      },
      deleteExpired: async () => [],
    },
  };
}

/**
 * In-memory {@link StagingStore} backed by a byte map. `writeChunk` yields a
 * microtask before mutating so two concurrent appends would interleave if the
 * service didn't serialize them — letting the lock test detect corruption.
 */
function fakeStaging(): { store: StagingStore; removed: string[] } {
  const files = new Map<string, number[]>();
  const removed: string[] = [];
  return {
    removed,
    store: {
      writeChunk: async (key, offset, data) => {
        await Promise.resolve(); // force a scheduling boundary
        const buf = files.get(key) ?? [];
        for (let i = 0; i < data.byteLength; i++) buf[offset + i] = data[i] ?? 0;
        files.set(key, buf);
      },
      readAll: async (key) => Uint8Array.from(files.get(key) ?? []),
      remove: async (key) => {
        files.delete(key);
        removed.push(key);
      },
    },
  };
}

/** An {@link AssetService} whose `create` is driven by the test; rest unused. */
function fakeAssetService(create: AssetService["create"]): AssetService {
  const unused = () => {
    throw new Error("not used in upload-service tests");
  };
  return {
    create,
    list: unused as AssetService["list"],
    getById: unused as AssetService["getById"],
    update: unused as AssetService["update"],
    openFile: unused as AssetService["openFile"],
  };
}

describe("createUploadService.appendChunk", () => {
  it("serializes concurrent PATCHes at the same offset (one commits, one 409s)", async () => {
    const sessions = fakeSessions({ token: "tok", declaredSize: 8 });
    const staging = fakeStaging();
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => ({ asset: sampleAsset, deduped: false })),
      1024,
    );

    const a = new Uint8Array([1, 1, 1, 1]);
    const b = new Uint8Array([2, 2, 2, 2]);
    const results = await Promise.allSettled([
      service.appendChunk("tok", 0, a),
      service.appendChunk("tok", 0, b),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // Exactly one writer wins; the other is rejected as an offset conflict.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UploadConflictError);

    // The committed offset reflects exactly one 4-byte chunk, and the staged
    // bytes are one writer's payload intact (all 1s or all 2s) — never an
    // interleaved mix, which is what a missing lock would produce.
    expect(sessions.get("tok")?.uploadedSize).toBe(4);
    const staged = await staging.store.readAll("tok");
    expect(staged).toHaveLength(4);
    expect(new Set(staged).size).toBe(1);
    expect(staged[0] === 1 || staged[0] === 2).toBe(true);
  });

  it("keeps the staged bytes + session when finalize fails transiently", async () => {
    const sessions = fakeSessions({ token: "tok", declaredSize: 4 });
    const staging = fakeStaging();
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => {
        throw new Error("database is temporarily unavailable");
      }),
      1024,
    );

    await expect(service.appendChunk("tok", 0, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      "temporarily unavailable",
    );
    // Resumable: nothing cleaned up, so a retry/GC can still recover it.
    expect(sessions.get("tok")).toBeDefined();
    expect(staging.removed).toHaveLength(0);
  });

  it("cleans up the session + staging when the bytes are undecodable (permanent)", async () => {
    const sessions = fakeSessions({ token: "tok", declaredSize: 4 });
    const staging = fakeStaging();
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => {
        throw new UnsupportedMediaError();
      }),
      1024,
    );

    await expect(
      service.appendChunk("tok", 0, new Uint8Array([1, 2, 3, 4])),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);
    // Permanent failure: no point keeping undecodable bytes around.
    expect(sessions.get("tok")).toBeUndefined();
    expect(staging.removed).toEqual(["tok"]);
  });

  it("finalizes into an asset and cleans up on success", async () => {
    const sessions = fakeSessions({ token: "tok", declaredSize: 4 });
    const staging = fakeStaging();
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => ({ asset: sampleAsset, deduped: false })),
      1024,
    );

    const result = await service.appendChunk("tok", 0, new Uint8Array([1, 2, 3, 4]));
    expect(result).toEqual({ status: "complete", asset: sampleAsset, deduped: false });
    expect(sessions.get("tok")).toBeUndefined();
    expect(staging.removed).toEqual(["tok"]);
  });
});
