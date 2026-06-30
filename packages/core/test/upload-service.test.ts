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
      expiresAt: initial.expiresAt ?? new Date(Date.now() + 60_000),
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
      deleteExpired: async (at: Date, limit?: number) => {
        const expired = [...rows.values()]
          .filter((r) => r.expiresAt < at)
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
        const batch = limit === undefined ? expired : expired.slice(0, limit);
        for (const r of batch) rows.delete(r.token);
        return batch.map((r) => ({ token: r.token, stagingKey: r.stagingKey }));
      },
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
      open: (key) => new Blob([Uint8Array.from(files.get(key) ?? [])]),
      remove: async (key) => {
        files.delete(key);
        removed.push(key);
      },
    },
  };
}

/**
 * An {@link AssetService} whose finalize entry point is driven by the test. The
 * upload service finalizes via `createFromSource`, so the handler is wired there
 * (and to `create` for parity); the rest are unused.
 */
function fakeAssetService(finalize: AssetService["createFromSource"]): AssetService {
  const unused = () => {
    throw new Error("not used in upload-service tests");
  };
  return {
    createFromSource: finalize,
    create: unused as AssetService["create"],
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
    const staged = new Uint8Array(await staging.store.open("tok").arrayBuffer());
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

  it("re-finalizes on a retried terminal chunk after a transient failure", async () => {
    const sessions = fakeSessions({ token: "tok", declaredSize: 4 });
    const staging = fakeStaging();
    let calls = 0;
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient storage failure");
        return { asset: sampleAsset, deduped: false };
      }),
      1024,
    );

    // First terminal chunk fills the file but finalize fails transiently: the
    // bytes + session are kept (offset stays committed at the declared size).
    await expect(service.appendChunk("tok", 0, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      "transient",
    );
    expect(sessions.get("tok")?.uploadedSize).toBe(4);
    expect(staging.removed).toHaveLength(0);

    // The client re-drives finalization with a zero-length PATCH at the declared
    // size; this time it succeeds and cleans up.
    const result = await service.appendChunk("tok", 4, new Uint8Array(0));
    expect(result).toEqual({ status: "complete", asset: sampleAsset, deduped: false });
    expect(sessions.get("tok")).toBeUndefined();
    expect(staging.removed).toEqual(["tok"]);
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

  it("serializes cancel against an in-flight append (no interleave)", async () => {
    const sessions = fakeSessions({ token: "tok", declaredSize: 4 });
    const staging = fakeStaging();
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => ({ asset: sampleAsset, deduped: false })),
      1024,
    );

    // append is registered on the session lock first, so it runs to completion
    // (finalize → delete session) before cancel's lookup; cancel then finds no
    // session rather than racing the delete/remove mid-append.
    const [appendResult, cancelResult] = await Promise.all([
      service.appendChunk("tok", 0, new Uint8Array([1, 2, 3, 4])),
      service.cancel("tok"),
    ]);
    expect(appendResult).toEqual({ status: "complete", asset: sampleAsset, deduped: false });
    expect(cancelResult).toBe(false);
    expect(sessions.get("tok")).toBeUndefined();
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

describe("createUploadService.gcExpired", () => {
  const assetService = fakeAssetService(async () => ({ asset: sampleAsset, deduped: false }));

  it("removes expired sessions and their staging files, returning the count", async () => {
    const sessions = fakeSessions({ token: "old", expiresAt: new Date(Date.now() - 1000) });
    const staging = fakeStaging();
    const service = createUploadService(sessions.repo, staging.store, assetService, 1024);

    const removed = await service.gcExpired();
    expect(removed).toBe(1);
    expect(sessions.get("old")).toBeUndefined();
    expect(staging.removed).toEqual(["old"]); // stagingKey defaults to the token
  });

  it("leaves a still-valid session untouched", async () => {
    const sessions = fakeSessions({ token: "fresh", expiresAt: new Date(Date.now() + 60_000) });
    const staging = fakeStaging();
    const service = createUploadService(sessions.repo, staging.store, assetService, 1024);

    const removed = await service.gcExpired();
    expect(removed).toBe(0);
    expect(sessions.get("fresh")).toBeDefined();
    expect(staging.removed).toEqual([]);
  });

  it("drains a backlog larger than the batch size across multiple batches", async () => {
    const sessions = fakeSessions();
    const staging = fakeStaging();
    // gcBatchSize = 2 with 5 expired sessions → 3 batches (2 + 2 + 1).
    const service = createUploadService(
      sessions.repo,
      staging.store,
      assetService,
      1024,
      () => new Date(),
      2,
    );
    const past = new Date(Date.now() - 1000);
    for (let i = 0; i < 5; i++) {
      await sessions.repo.create({
        token: `t${i}`,
        filename: "f.png",
        mimeType: null,
        declaredSize: 4,
        uploadedSize: 0,
        stagingKey: `t${i}`,
        uploaderId: null,
        expiresAt: past,
      });
    }

    // A single unbounded delete would return only the first batch; draining all
    // five proves gcExpired loops over batches.
    const removed = await service.gcExpired();
    expect(removed).toBe(5);
    expect([...staging.removed].sort()).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    for (let i = 0; i < 5; i++) expect(sessions.get(`t${i}`)).toBeUndefined();
  });

  it("waits for an in-flight finalize before removing its staging file", async () => {
    // The session is expired AND being finalized: GC must not delete the staged
    // file out from under the finalize, which reads the lazy Blob under the lock.
    const sessions = fakeSessions({ token: "tok", declaredSize: 4, expiresAt: new Date(Date.now() - 1000) });
    const staging = fakeStaging();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let signalReached!: () => void;
    const reached = new Promise<void>((r) => (signalReached = r));
    const service = createUploadService(
      sessions.repo,
      staging.store,
      fakeAssetService(async () => {
        signalReached(); // finalize has entered, holding the session lock
        await gate;
        return { asset: sampleAsset, deduped: false };
      }),
      1024,
    );

    const finalizeP = service.appendChunk("tok", 0, new Uint8Array([1, 2, 3, 4]));
    await reached;

    // Sweep concurrently: it deletes the row, then queues the staging removal
    // behind the held lock — so the file is NOT removed while finalize runs.
    const gcP = service.gcExpired();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The row is already deleted, so the sweep HAS progressed past its bulk
    // delete and is now blocked on the staging lock — without this, the "not
    // removed" check could pass simply because GC hadn't reached cleanup yet.
    expect(sessions.get("tok")).toBeUndefined();
    expect(staging.removed).not.toContain("tok");

    release();
    const result = await finalizeP;
    await gcP;
    expect(result).toEqual({ status: "complete", asset: sampleAsset, deduped: false });
    expect(staging.removed).toContain("tok"); // removed only after finalize finished
  });
});
