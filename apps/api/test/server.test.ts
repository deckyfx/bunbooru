import { describe, expect, it } from "bun:test";

import type {
  ApiKey,
  Asset,
  AssetListPage,
  AssetService,
  AssetUpdate,
  AuthService,
  Core,
  ListAssetsOptions,
  SettingsService,
  StatsService,
  Tag,
  TagService,
  UploadService,
  User,
} from "@bunbooru/core";
import {
  AuthenticationError,
  AuthorizationError,
  createCoreEvents,
  RegistrationConflictError,
  UnsupportedMediaError,
  UploadConflictError,
  ValidationError,
} from "@bunbooru/core";

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
  viewCount: 0,
  // Owned by the default authenticated user (sampleUser.id below) so the
  // owner-or-admin edit routes admit it under AUTH_HEADER.
  uploaderId: 7,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

const emptyPage: AssetListPage = { assets: [], total: 0, page: 1, perPage: 20, pageCount: 0 };

/** A fixed tag row for asserting wire serialization. */
const sampleTag: Tag = {
  id: 1,
  name: "1girl",
  category: "general",
  postCount: 42,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** A fixed user row; its `passwordHash` must never appear on the wire. */
const sampleUser: User = {
  id: 7,
  username: "tester",
  email: null,
  passwordHash: "argon2-hash-should-never-leak",
  role: "member",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** An admin user for the admin-gated routes (`sampleUser` is a member). */
const adminUser: User = { ...sampleUser, id: 1, username: "admin", role: "admin" };

/** A fixed API-key row (the raw token is never part of the row). */
const sampleApiKey: ApiKey = {
  id: 10,
  tokenHash: "hash",
  userId: sampleUser.id,
  name: "cli",
  lastUsedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** Opaque session token the default stub treats as a valid, authenticated session. */
const SESSION_TOKEN = "test-session-token";

/** Authorization header carrying {@link SESSION_TOKEN} (Bearer transport). */
const AUTH_HEADER = { authorization: `Bearer ${SESSION_TOKEN}` } as const;

/** Small upload cap so the oversize path is cheap to exercise. */
const MAX_UPLOAD_BYTES = 1024;

/** Build a Core, overriding only the service methods a test cares about. */
function stubCore(
  overrides: Partial<AssetService> = {},
  uploadOverrides: Partial<UploadService> = {},
  tagOverrides: Partial<TagService> = {},
  statsOverrides: Partial<StatsService> = {},
  authOverrides: Partial<AuthService> = {},
  settingsOverrides: Partial<SettingsService> = {},
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
    tagService: {
      setAssetTags: async () => [sampleTag],
      listForAsset: async () => [sampleTag],
      autocomplete: async () => [sampleTag],
      setCategory: async () => sampleTag,
      ...tagOverrides,
    },
    statsService: {
      recordView: async () => true,
      recordVisit: async () => undefined,
      getStats: async () => ({ posts: 0, visitorsToday: 0 }),
      ...statsOverrides,
    },
    authService: {
      register: async () => ({ token: SESSION_TOKEN, user: sampleUser }),
      login: async () => ({ token: SESSION_TOKEN, user: sampleUser }),
      // Only the canonical token resolves — so the Bearer/cookie tests actually
      // exercise correct token EXTRACTION (a raw-header or wrong-cookie parse
      // would yield a different string and fail to authenticate).
      currentUser: async (token) => (token === SESSION_TOKEN ? sampleUser : null),
      logout: async () => undefined,
      gcExpiredSessions: async () => 0,
      createApiKey: async () => ({ key: "bnb_secret", record: sampleApiKey }),
      listApiKeys: async () => [sampleApiKey],
      revokeApiKey: async () => true,
      ...authOverrides,
    },
    settingsService: {
      getUploadLimits: async () => ({
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxResumableUploadBytes: MAX_UPLOAD_BYTES,
      }),
      updateUploadLimits: async (patch) => ({
        maxUploadBytes: patch.maxUploadBytes ?? MAX_UPLOAD_BYTES,
        maxResumableUploadBytes: patch.maxResumableUploadBytes ?? MAX_UPLOAD_BYTES,
      }),
      ...settingsOverrides,
    },
    events: createCoreEvents(),
  };
}

/** Build the app over a (stub) Core. */
function buildApp(core: Core) {
  return createApp({ core });
}

const app = buildApp(stubCore());

/** Drive the default app in-process — no port, no listen() — via Elysia's handle(). */
function request(path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

/** A multipart upload request carrying `bytes` as a file field (authenticated). */
function uploadRequest(bytes: Uint8Array, type = "image/png"): Request {
  const form = new FormData();
  form.append("file", new File([bytes], "upload.png", { type }));
  // Only the Authorization header is set; the multipart content-type (with its
  // boundary) is inferred from the FormData body.
  return new Request("http://localhost/api/v1/assets", {
    method: "POST",
    headers: AUTH_HEADER,
    body: form,
  });
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
      getById: async () => sampleAsset, // route fetches first for the ownership check
      update: async (id, patch) => {
        receivedId = id;
        receivedPatch = patch;
        return updated;
      },
    });
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...AUTH_HEADER },
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
      getById: async () => sampleAsset, // route fetches first for the ownership check
      update: async (_id, patch) => {
        receivedPatch = patch;
        return { ...sampleAsset, rating: "unrated" };
      },
    });
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...AUTH_HEADER },
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
        headers: { "content-type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ rating: "safe" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid rating with 422", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...AUTH_HEADER },
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
        headers: { "content-type": "application/json", ...AUTH_HEADER },
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
        headers: { "content-type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ filename: "big.png", size: MAX_UPLOAD_BYTES + 1 }),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("HEAD /uploads/:token reports the committed offset + length", async () => {
    const res = await buildApp(
      stubCore({}, { offsetOf: async () => ({ offset: 42, size: 100 }) }),
    ).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", { method: "HEAD", headers: AUTH_HEADER }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("upload-offset")).toBe("42");
    expect(res.headers.get("upload-length")).toBe("100");
  });

  it("HEAD /uploads/:token returns 404 for an unknown session", async () => {
    const res = await buildApp(stubCore({}, { offsetOf: async () => null })).handle(
      new Request("http://localhost/api/v1/uploads/nope", { method: "HEAD", headers: AUTH_HEADER }),
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
        headers: { "upload-offset": "0", "content-type": "application/octet-stream", ...AUTH_HEADER },
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
        headers: { "upload-offset": "0", "content-type": "application/octet-stream", ...AUTH_HEADER },
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
        headers: { "upload-offset": "5", "content-type": "application/octet-stream", ...AUTH_HEADER },
        body: new Uint8Array([1]),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("PATCH /uploads/:token rejects a missing Upload-Offset header with 400", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", {
        method: "PATCH",
        headers: { "content-type": "application/octet-stream", ...AUTH_HEADER },
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
    ).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", { method: "DELETE", headers: AUTH_HEADER }),
    );
    expect(res.status).toBe(204);
    expect(cancelled).toBe("tok-1");
  });
});

describe("tags", () => {
  const tagJson = { name: "1girl", category: "general", postCount: 42 };

  it("GET /assets/:id/tags → 404 when the asset is absent", async () => {
    const res = await buildApp(stubCore({ getById: async () => null })).handle(
      new Request("http://localhost/api/v1/assets/1/tags"),
    );
    expect(res.status).toBe(404);
  });

  it("GET /assets/:id/tags → 200 with the asset's tags", async () => {
    const res = await buildApp(stubCore({ getById: async () => sampleAsset })).handle(
      new Request("http://localhost/api/v1/assets/1/tags"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([tagJson]);
  });

  it("PATCH /assets/:id/tags sets the full list and returns the result", async () => {
    let received: string[] | undefined;
    const res = await buildApp(
      stubCore({ getById: async () => sampleAsset }, {}, {
        setAssetTags: async (_id, names) => {
          received = names;
          return [sampleTag];
        },
      }),
    ).handle(
      new Request("http://localhost/api/v1/assets/1/tags", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ tags: ["1girl", "solo"] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toEqual(["1girl", "solo"]);
    expect(await res.json()).toEqual([tagJson]);
  });

  it("PATCH /assets/:id/tags → 404 when the asset is absent", async () => {
    const res = await buildApp(stubCore({ getById: async () => null })).handle(
      new Request("http://localhost/api/v1/assets/1/tags", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ tags: [] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("GET /tags returns popularity-ordered autocomplete matches", async () => {
    const res = await buildApp(
      stubCore({}, {}, { autocomplete: async () => [sampleTag] }),
    ).handle(new Request("http://localhost/api/v1/tags?q=1gi"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([tagJson]);
  });
});

describe("traffic counters", () => {
  it("POST /assets/:id/view records a view (404 absent asset, 400 absent visitor id)", async () => {
    const headers = { "x-visitor-id": "abcdef12-3456-7890-abcd-ef1234567890" };

    const ok = await buildApp(stubCore({ getById: async () => sampleAsset })).handle(
      new Request("http://localhost/api/v1/assets/1/view", { method: "POST", headers }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ counted: true });

    const missing = await buildApp(stubCore({ getById: async () => null })).handle(
      new Request("http://localhost/api/v1/assets/999/view", { method: "POST", headers }),
    );
    expect(missing.status).toBe(404);

    // No visitor id → 400 (before any asset lookup).
    const noVisitor = await buildApp(stubCore({ getById: async () => sampleAsset })).handle(
      new Request("http://localhost/api/v1/assets/1/view", { method: "POST" }),
    );
    expect(noVisitor.status).toBe(400);
  });

  it("GET /stats returns site counters", async () => {
    const res = await buildApp(
      stubCore({}, {}, {}, { getStats: async () => ({ posts: 12, visitorsToday: 3 }) }),
    ).handle(new Request("http://localhost/api/v1/stats"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posts: 12, visitorsToday: 3 });
  });

  it("attributes a visit to a valid x-visitor-id header and 400s when it's absent", async () => {
    const seen: string[] = [];
    const core = stubCore(
      {},
      {},
      {},
      {
        recordVisit: async (visitorId) => {
          seen.push(visitorId);
        },
      },
    );

    // A valid header is used as the visitor id, as-is.
    const withHeader = await buildApp(core).handle(
      new Request("http://localhost/api/v1/stats/visit", {
        method: "POST",
        headers: { "x-visitor-id": "abcdef12-3456-7890-abcd-ef1234567890" },
      }),
    );
    expect(await withHeader.json()).toEqual({ ok: true });
    expect(seen).toEqual(["abcdef12-3456-7890-abcd-ef1234567890"]);

    // No header → 400 and nothing recorded (we never synthesize a throwaway id,
    // which would count every header-less request as a fresh visitor).
    const noHeader = await buildApp(core).handle(
      new Request("http://localhost/api/v1/stats/visit", { method: "POST" }),
    );
    expect(noHeader.status).toBe(400);
    expect(seen).toEqual(["abcdef12-3456-7890-abcd-ef1234567890"]);
  });
});

describe("auth", () => {
  /** Anonymous multipart upload (no Authorization header / cookie). */
  function anonUpload(): Request {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "u.png", { type: "image/png" }));
    return new Request("http://localhost/api/v1/assets", { method: "POST", body: form });
  }

  it("register → 201 with Set-Cookie, a token, and no password hash", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "tester", password: "supersecret" }),
      }),
    );
    expect(res.status).toBe(201);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bunbooru_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // Not secure in the test env (served over http://localhost).
    expect(cookie).not.toContain("Secure");

    const body = (await res.json()) as { user: Record<string, unknown>; token: string };
    expect(body.token).toBe(SESSION_TOKEN);
    expect(body.user.username).toBe("tester");
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  it("register → 409 on a duplicate username/email", async () => {
    const res = await buildApp(
      stubCore({}, {}, {}, {}, {
        register: async () => {
          throw new RegistrationConflictError();
        },
      }),
    ).handle(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "taken", password: "supersecret" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("register → 422 when the password is too short", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "tester", password: "short" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("register → 422 when the username is whitespace-only", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "   ", password: "supersecret" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("login → 200 with a token + Set-Cookie; forwards credentials", async () => {
    let received: { username: string; password: string } | undefined;
    const res = await buildApp(
      stubCore({}, {}, {}, {}, {
        login: async (username, password) => {
          received = { username, password };
          return { token: SESSION_TOKEN, user: sampleUser };
        },
      }),
    ).handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "tester", password: "supersecret" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toEqual({ username: "tester", password: "supersecret" });
    expect(res.headers.get("set-cookie") ?? "").toContain("bunbooru_session=");
    const body = (await res.json()) as { token: string };
    expect(body.token).toBe(SESSION_TOKEN);
  });

  it("login → 401 on bad credentials", async () => {
    const res = await buildApp(
      stubCore({}, {}, {}, {}, {
        login: async () => {
          throw new AuthenticationError();
        },
      }),
    ).handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "tester", password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("GET /auth/me → the user with a valid cookie, null without", async () => {
    const app = buildApp(stubCore());

    const withCookie = await app.handle(
      new Request("http://localhost/api/v1/auth/me", {
        headers: { cookie: `bunbooru_session=${SESSION_TOKEN}` },
      }),
    );
    expect(withCookie.status).toBe(200);
    const body = (await withCookie.json()) as { user: { username: string } | null };
    expect(body.user?.username).toBe("tester");

    const anon = await app.handle(new Request("http://localhost/api/v1/auth/me"));
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ user: null });
  });

  it("logout → 204 and clears the cookie (Max-Age=0)", async () => {
    let revoked: string | undefined;
    const res = await buildApp(
      stubCore({}, {}, {}, {}, {
        logout: async (token) => {
          revoked = token;
        },
      }),
    ).handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: `bunbooru_session=${SESSION_TOKEN}` },
      }),
    );
    expect(res.status).toBe(204);
    expect(revoked).toBe(SESSION_TOKEN);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("gated writes → 401 without a session", async () => {
    const app = buildApp(stubCore());

    const post = await app.handle(anonUpload());
    expect(post.status).toBe(401);

    const patch = await app.handle(
      new Request("http://localhost/api/v1/assets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "safe" }),
      }),
    );
    expect(patch.status).toBe(401);

    const beginUpload = await app.handle(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "a.png", size: 10 }),
      }),
    );
    expect(beginUpload.status).toBe(401);
  });

  it("accepts auth via cookie as well as Bearer, and attributes the upload", async () => {
    // Collect into an array (a closure-assigned `let` narrows to its initializer
    // under control-flow analysis, so a plain variable would type as `undefined`).
    const uploaderIds: Array<number | null> = [];
    const core = stubCore({
      create: async (input) => {
        uploaderIds.push(input.uploaderId ?? null);
        return { asset: sampleAsset, deduped: false };
      },
    });

    // Bearer transport (handled by uploadRequest's Authorization header).
    const viaBearer = await buildApp(core).handle(uploadRequest(new Uint8Array([1, 2, 3, 4])));
    expect(viaBearer.status).toBe(201);

    // Cookie transport.
    const form = new FormData();
    form.append("file", new File([new Uint8Array([5, 6, 7])], "u.png", { type: "image/png" }));
    const viaCookie = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets", {
        method: "POST",
        headers: { cookie: `bunbooru_session=${SESSION_TOKEN}` },
        body: form,
      }),
    );
    expect(viaCookie.status).toBe(201);

    // Both transports attributed the upload to the authenticated user.
    expect(uploaderIds).toEqual([sampleUser.id, sampleUser.id]);
  });
});

describe("superadmin, settings, and API keys", () => {
  /** Auth override that resolves any token to an admin. */
  const adminAuth: Partial<AuthService> = { currentUser: async () => adminUser };
  /** An asset owned by someone other than the default (member) user. */
  const foreignAsset: Asset = { ...sampleAsset, uploaderId: 999 };

  function jsonReq(path: string, method: string, body: unknown, auth = true): Request {
    return new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", ...(auth ? AUTH_HEADER : {}) },
      body: JSON.stringify(body),
    });
  }

  it("PATCH /tags/:name sets a category for an admin", async () => {
    let received: { name: string; category: string } | undefined;
    const core = stubCore({}, {}, {
      setCategory: async (name, category) => {
        received = { name, category };
        return { ...sampleTag, category };
      },
    }, {}, adminAuth);
    const res = await buildApp(core).handle(jsonReq("/tags/1girl", "PATCH", { category: "character" }));
    expect(res.status).toBe(200);
    expect(received).toEqual({ name: "1girl", category: "character" });
  });

  it("PATCH /tags/:name → 403 for a member, 401 for anon", async () => {
    const member = await buildApp(stubCore()).handle(jsonReq("/tags/1girl", "PATCH", { category: "meta" }));
    expect(member.status).toBe(403);
    const anon = await buildApp(stubCore()).handle(
      jsonReq("/tags/1girl", "PATCH", { category: "meta" }, false),
    );
    expect(anon.status).toBe(401);
  });

  it("PATCH /tags/:name → 404 when the tag doesn't exist", async () => {
    const core = stubCore({}, {}, { setCategory: async () => null }, {}, adminAuth);
    const res = await buildApp(core).handle(jsonReq("/tags/nope", "PATCH", { category: "meta" }));
    expect(res.status).toBe(404);
  });

  it("PATCH /assets/:id → 403 for a non-owner member, 200 for an admin", async () => {
    const forbidden = await buildApp(stubCore({ getById: async () => foreignAsset })).handle(
      jsonReq("/assets/1", "PATCH", { rating: "safe" }),
    );
    expect(forbidden.status).toBe(403);

    const allowed = await buildApp(
      stubCore({ getById: async () => foreignAsset, update: async () => foreignAsset }, {}, {}, {}, adminAuth),
    ).handle(jsonReq("/assets/1", "PATCH", { rating: "safe" }));
    expect(allowed.status).toBe(200);
  });

  it("PATCH /assets/:id/tags → 403 for a non-owner member", async () => {
    const res = await buildApp(stubCore({ getById: async () => foreignAsset })).handle(
      jsonReq("/assets/1/tags", "PATCH", { tags: ["1girl"] }),
    );
    expect(res.status).toBe(403);
  });

  it("maps an upload-session ownership error (from the service) to 403", async () => {
    const core = stubCore({}, {
      offsetOf: async () => {
        throw new AuthorizationError();
      },
    });
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/uploads/tok-1", { method: "HEAD", headers: AUTH_HEADER }),
    );
    expect(res.status).toBe(403);
  });

  it("GET /settings returns caps for an admin, 403 for a member", async () => {
    const ok = await buildApp(stubCore({}, {}, {}, {}, adminAuth)).handle(
      new Request("http://localhost/api/v1/settings", { headers: AUTH_HEADER }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      maxUploadBytes: MAX_UPLOAD_BYTES,
      maxResumableUploadBytes: MAX_UPLOAD_BYTES,
    });

    const forbidden = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/settings", { headers: AUTH_HEADER }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("PATCH /settings updates caps for an admin", async () => {
    const res = await buildApp(stubCore({}, {}, {}, {}, adminAuth)).handle(
      jsonReq("/settings", "PATCH", { maxUploadBytes: 2048 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxUploadBytes: 2048, maxResumableUploadBytes: MAX_UPLOAD_BYTES });
  });

  it("PATCH /settings → 400 on a domain ValidationError", async () => {
    const core = stubCore({}, {}, {}, {}, adminAuth, {
      updateUploadLimits: async () => {
        throw new ValidationError("too big");
      },
    });
    const res = await buildApp(core).handle(jsonReq("/settings", "PATCH", { maxUploadBytes: 9_000_000_000 }));
    expect(res.status).toBe(400);
  });

  it("POST /account/api-keys returns the raw key once (201)", async () => {
    const res = await buildApp(stubCore()).handle(jsonReq("/account/api-keys", "POST", { name: "cli" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; name: string; key: string };
    expect(body.key).toBe("bnb_secret");
    expect(body.name).toBe("cli");
  });

  it("GET /account/api-keys lists keys without secrets", async () => {
    const res = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/account/api-keys", { headers: AUTH_HEADER }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]?.name).toBe("cli");
    expect(body[0]).not.toHaveProperty("key");
    expect(body[0]).not.toHaveProperty("tokenHash");
  });

  it("DELETE /account/api-keys/:id → 204, or 404 when not the caller's", async () => {
    const ok = await buildApp(stubCore()).handle(
      new Request("http://localhost/api/v1/account/api-keys/10", { method: "DELETE", headers: AUTH_HEADER }),
    );
    expect(ok.status).toBe(204);

    const missing = await buildApp(stubCore({}, {}, {}, {}, { revokeApiKey: async () => false })).handle(
      new Request("http://localhost/api/v1/account/api-keys/999", { method: "DELETE", headers: AUTH_HEADER }),
    );
    expect(missing.status).toBe(404);
  });

  it("authenticates a gated write via an API-key Bearer token", async () => {
    const core = stubCore({}, {}, {}, {}, {
      currentUser: async (token) => (token === "bnb_key" ? sampleUser : null),
    });
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "u.png", { type: "image/png" }));
    const res = await buildApp(core).handle(
      new Request("http://localhost/api/v1/assets", {
        method: "POST",
        headers: { authorization: "Bearer bnb_key" },
        body: form,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("rate-limits repeated logins with 429 after the window max", async () => {
    const app = buildApp(stubCore());
    const login = () =>
      app.handle(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "u", password: "supersecret" }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await login()).status);
    // The first 10 (LOGIN_RATE.max) succeed; the rest are throttled.
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });
});
