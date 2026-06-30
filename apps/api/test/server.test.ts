import { describe, expect, it } from "bun:test";

import type {
  Asset,
  AssetListPage,
  AssetService,
  AssetUpdate,
  Core,
  ListAssetsOptions,
  UploadService,
} from "@bunbooru/core";
import { createCoreEvents, UnsupportedMediaError, UploadConflictError } from "@bunbooru/core";

import { createApp } from "../src/server";

/** A fixed asset row for asserting wire serialization. */
const sampleAsset: Asset = {
  id: 1,
  storageKey: "assets/ab/cd/abcd.png",
  mimeType: "image/png",
  width: 800,
  height: 600,
  sizeBytes: 123_456,
  sha256: "a1b2c3d4".repeat(8), // 64-char lowercase hex
  md5: "a1b2c3d4".repeat(4), // 32-char lowercase hex
  rating: "safe",
  source: null,
  uploaderId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

const emptyPage: AssetListPage = { assets: [], total: 0, page: 1, perPage: 20, pageCount: 0 };

/** Small upload cap so the oversize path is cheap to exercise. */
const MAX_UPLOAD_BYTES = 1024;

/** Build a Core, overriding only the service methods a test cares about. */
function stubCore(
  overrides: Partial<AssetService> = {},
  uploadOverrides: Partial<UploadService> = {},
): Core {
  return {
    assetService: {
      list: async () => emptyPage,
      getById: async () => null,
      create: async () => ({ asset: sampleAsset, deduped: false }),
      createFromSource: async () => ({ asset: sampleAsset, deduped: false }),
      update: async () => null,
      openFile: async () => null,
      gcOrphanedBlobs: async () => 0,
      ...overrides,
    },
    uploadService: {
      begin: async () => ({ token: "tok-1", offset: 0, size: 100 }),
      offsetOf: async () => ({ offset: 0, size: 100 }),
      appendChunk: async () => ({ status: "incomplete", offset: 0 }),
      cancel: async () => true,
      gcExpired: async () => 0,
      ...uploadOverrides,
    },
    events: createCoreEvents(),
  };
}

/** Build the app with the test upload cap. */
function buildApp(core: Core) {
  return createApp({ core, maxUploadBytes: MAX_UPLOAD_BYTES });
}

const app = buildApp(stubCore());

/** Drive the default app in-process — no port, no listen() — via Elysia's handle(). */
function request(path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

/** A multipart upload request carrying `bytes` as a file field. */
function uploadRequest(bytes: Uint8Array, type = "image/png"): Request {
  const form = new FormData();
  form.append("file", new File([bytes], "upload.png", { type }));
  return new Request("http://localhost/api/v1/assets", { method: "POST", body: form });
}

describe("health", () => {
  it("GET /health -> 200 ok", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/v1/health -> 200 ok", async () => {
    const res = await request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("root", () => {
  it("GET / reports service identity", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.sdk).toBeString();
  });
});

describe("request id", () => {
  it("stamps every response with x-request-id", async () => {
    const res = await request("/health");
    expect(res.headers.get("x-request-id")).toBeString();
  });

  it("issues a unique id per request", async () => {
    const a = await request("/health");
    const b = await request("/health");
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  it("propagates a caller-supplied x-request-id", async () => {
    const res = await app.handle(
      new Request("http://localhost/health", {
        headers: { "x-request-id": "trace-abc-123" },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("generates an id when the incoming one is implausibly long", async () => {
    const res = await app.handle(
      new Request("http://localhost/health", {
        headers: { "x-request-id": "x".repeat(200) },
      }),
    );
    const id = res.headers.get("x-request-id");
    expect(id).toBeString();
    expect(id).not.toBe("x".repeat(200));
  });
});

describe("error handling", () => {
  it("returns a safe, correlated 404 (no stack trace)", async () => {
    const res = await request("/nope");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error?: { message?: string; requestId?: string } };
    expect(body.error?.message).toBeString();
    expect(body.error?.requestId).toBe(res.headers.get("x-request-id") ?? "");
    expect(JSON.stringify(body)).not.toContain("stack");
  });
});

describe("GET /api/v1/assets", () => {
  it("returns a page and serializes timestamps as ISO strings", async () => {
    const page: AssetListPage = { assets: [sampleAsset], total: 1, page: 1, perPage: 20, pageCount: 1 };
    const res = await buildApp(stubCore({ list: async () => page })).handle(
      new Request("http://localhost/api/v1/assets"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      assets: Array<{ id: number; createdAt: unknown; updatedAt: unknown }>;
    };
    expect(body.total).toBe(1);
    expect(body.assets[0]?.id).toBe(1);
    expect(body.assets[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.assets[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("coerces and forwards page/per_page to the service", async () => {
    let received: ListAssetsOptions | undefined;
    const res = await buildApp(
      stubCore({
        list: async (options = {}) => {
          received = options;
          return emptyPage;
        },
      }),
    ).handle(new Request("http://localhost/api/v1/assets?page=2&per_page=5"));

    expect(res.status).toBe(200);
    expect(received).toEqual({ page: 2, perPage: 5 });
  });

  it("forwards the q search query to the service", async () => {
    let received: ListAssetsOptions | undefined;
    const res = await buildApp(
      stubCore({
        list: async (options = {}) => {
          received = options;
          return emptyPage;
        },
      }),
    ).handle(new Request("http://localhost/api/v1/assets?q=rating%3Asafe+1girl"));

    expect(res.status).toBe(200);
    expect(received?.query).toBe("rating:safe 1girl");
  });

  it("rejects an out-of-range page with 422", async () => {
    const res = await request("/api/v1/assets?page=0");
    expect(res.status).toBe(422);
  });

  it("rejects a fractional page with 422", async () => {
    const res = await request("/api/v1/assets?page=1.5");
    expect(res.status).toBe(422);
  });
});

describe("POST /api/v1/assets", () => {
  it("stores a new upload and returns 201 with the asset", async () => {
    let receivedBytes: number | undefined;
    const core = stubCore({
      create: async ({ bytes }) => {
        receivedBytes = bytes.byteLength;
        return { asset: sampleAsset, deduped: false };
      },
    });
    const res = await buildApp(core).handle(uploadRequest(new Uint8Array([1, 2, 3, 4])));

    expect(res.status).toBe(201);
    expect(receivedBytes).toBe(4);
    const body = (await res.json()) as { id: number; createdAt: unknown };
    expect(body.id).toBe(1);
    expect(body.createdAt).toBe("2026-01-01T00:00:00.000Z"); // ISO wire form
  });

  it("returns 200 when the upload deduplicates to an existing asset", async () => {
    const core = stubCore({ create: async () => ({ asset: sampleAsset, deduped: true }) });
    const res = await buildApp(core).handle(uploadRequest(new Uint8Array([1, 2, 3])));
    expect(res.status).toBe(200);
  });

  it("rejects an oversize upload with 413", async () => {
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const res = await buildApp(stubCore()).handle(uploadRequest(tooBig));
    expect(res.status).toBe(413);
  });

  it("maps an unsupported media type to 415", async () => {
    const core = stubCore({
      create: async () => {
        throw new UnsupportedMediaError();
      },
    });
    const res = await buildApp(core).handle(uploadRequest(new Uint8Array([0, 1, 2])));
    expect(res.status).toBe(415);
  });
});

describe("GET /api/v1/assets/:id", () => {
  it("returns the asset metadata (ISO timestamps)", async () => {
    const res = await buildApp(stubCore({ getById: async () => sampleAsset })).handle(
      new Request("http://localhost/api/v1/assets/1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; createdAt: unknown };
    expect(body.id).toBe(1);
    expect(body.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns 404 when absent", async () => {
    const res = await buildApp(stubCore({ getById: async () => null })).handle(
      new Request("http://localhost/api/v1/assets/999"),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-numeric id with 422", async () => {
    const res = await request("/api/v1/assets/abc");
    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/v1/assets/:id", () => {
  it("forwards the rating+source patch to the service and returns the asset", async () => {
    let receivedId: number | undefined;
    let receivedPatch: AssetUpdate | undefined;
    const updated: Asset = { ...sampleAsset, rating: "explicit", source: "https://example.com" };
    const core = stubCore({
      update: async (id, patch) => {
        receivedId = id;
        receivedPatch = patch;
        return updated;
      },
    });
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "explicit", source: "https://example.com" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(receivedId).toBe(1);
    expect(receivedPatch).toEqual({ rating: "explicit", source: "https://example.com" });
    const body = (await res.json()) as { rating: string; source: string };
    expect(body.rating).toBe("explicit");
  });

  it("accepts the unrated rating", async () => {
    let receivedPatch: AssetUpdate | undefined;
    const core = stubCore({
      update: async (_id, patch) => {
        receivedPatch = patch;
        return { ...sampleAsset, rating: "unrated" };
      },
    });
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "unrated" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(receivedPatch).toEqual({ rating: "unrated" });
  });

  it("returns 404 when the asset is absent", async () => {
    const res = await buildApp(stubCore({ update: async () => null })).handle(
      new Request("http://localhost/api/v1/assets/999", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "safe" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid rating with 422", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "bogus" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("GET /api/v1/assets/:id/file", () => {
  it("streams the stored bytes with the asset's content type", async () => {
    const body = new Response("IMGBYTES").body;
    if (!body) throw new Error("expected a response body");
    const core = stubCore({
      openFile: async () => ({ stream: body, mimeType: "image/png", sizeBytes: 8 }),
    });
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets/1/file"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("IMGBYTES");
  });

  it("returns 404 when the asset is absent", async () => {
    const res = await buildApp(stubCore({ openFile: async () => null })).handle(
      new Request("http://localhost/api/v1/assets/999/file"),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-numeric id with 422", async () => {
    const res = await request("/api/v1/assets/abc/file");
    expect(res.status).toBe(422);
  });
});

describe("resumable uploads (/api/v1/uploads)", () => {
  it("POST /uploads opens a session (201) and forwards filename/size/mimeType", async () => {
    let received: { filename: string; size: number; mimeType?: string | null } | undefined;
    const res = await buildApp(
      stubCore(
        {},
        {
          begin: async (input) => {
            received = input;
            return { token: "tok-9", offset: 0, size: input.size };
          },
        },
      ),
    ).handle(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "a.png", size: 10, mimeType: "image/png" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(received).toMatchObject({ filename: "a.png", size: 10, mimeType: "image/png" });
    const body = (await res.json()) as { token: string; offset: number; size: number };
    expect(body.token).toBe("tok-9");
    expect(body.offset).toBe(0);
  });

  it("POST /uploads rejects an oversize declared size with 413", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "big.png", size: MAX_UPLOAD_BYTES + 1 }),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("HEAD /uploads/:token reports the committed offset + length", async () => {
    const res = await buildApp(
      stubCore({}, { offsetOf: async () => ({ offset: 42, size: 100 }) }),
    ).handle(new Request("http://localhost/api/v1/uploads/tok-1", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("upload-offset")).toBe("42");
    expect(res.headers.get("upload-length")).toBe("100");
  });

  it("HEAD /uploads/:token returns 404 for an unknown session", async () => {
    const res = await buildApp(stubCore({}, { offsetOf: async () => null })).handle(
      new Request("http://localhost/api/v1/uploads/nope", { method: "HEAD" }),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /uploads/:token appends a chunk → 204 + new offset (incomplete)", async () => {
    let received: { token: string; offset: number; len: number } | undefined;
    const res = await buildApp(
      stubCore(
        {},
        {
          appendChunk: async (token, offset, data) => {
            received = { token, offset, len: data.byteLength };
            return { status: "incomplete", offset: offset + data.byteLength };
          },
        },
      ),
    ).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", {
        method: "PATCH",
        headers: { "upload-offset": "0", "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("upload-offset")).toBe("4");
    expect(received).toEqual({ token: "tok-1", offset: 0, len: 4 });
  });

  it("PATCH /uploads/:token finalizes → 201 with the asset (complete)", async () => {
    const res = await buildApp(
      stubCore(
        {},
        { appendChunk: async () => ({ status: "complete", asset: sampleAsset, deduped: false }) },
      ),
    ).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", {
        method: "PATCH",
        headers: { "upload-offset": "0", "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number };
    expect(body.id).toBe(1);
  });

  it("PATCH /uploads/:token maps an offset mismatch to 409", async () => {
    const res = await buildApp(
      stubCore(
        {},
        {
          appendChunk: async () => {
            throw new UploadConflictError();
          },
        },
      ),
    ).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", {
        method: "PATCH",
        headers: { "upload-offset": "5", "content-type": "application/octet-stream" },
        body: new Uint8Array([1]),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("PATCH /uploads/:token rejects a missing Upload-Offset header with 400", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", {
        method: "PATCH",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1]),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("DELETE /uploads/:token cancels the session (204)", async () => {
    let cancelled: string | undefined;
    const res = await buildApp(
      stubCore(
        {},
        {
          cancel: async (token) => {
            cancelled = token;
            return true;
          },
        },
      ),
    ).handle(new Request("http://localhost/api/v1/uploads/tok-1", { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(cancelled).toBe("tok-1");
  });
});
