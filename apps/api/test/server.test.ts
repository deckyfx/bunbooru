import { describe, expect, it } from "bun:test";

import type { Asset, AssetListPage, Core, ListAssetsOptions } from "@bunbooru/core";

import { createApp } from "../src/server";

/** A fixed asset row for asserting wire serialization. */
const sampleAsset: Asset = {
  id: 1,
  storageKey: "ab/cd/abcd.png",
  mimeType: "image/png",
  width: 800,
  height: 600,
  sizeBytes: 123_456,
  md5: "abcd",
  rating: "safe",
  source: null,
  uploaderId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

/** Build a Core whose asset service returns `page` and records the options it got. */
function stubCore(
  page: AssetListPage,
  onList?: (options: ListAssetsOptions) => void,
): Core {
  return {
    assetService: {
      list: async (options = {}) => {
        onList?.(options);
        return page;
      },
    },
  };
}

const emptyPage: AssetListPage = { assets: [], total: 0, page: 1, perPage: 20, pageCount: 0 };

/** Default app with an empty-page stub, for routes that don't touch assets. */
const app = createApp({ core: stubCore(emptyPage) });

/** Drive an app in-process — no port, no listen() — via Elysia's handle(). */
function request(path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
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
    // request id is echoed both in the header and the body, and they match
    expect(body.error?.requestId).toBe(res.headers.get("x-request-id") ?? "");
    // never leak internals
    expect(JSON.stringify(body)).not.toContain("stack");
  });
});

describe("GET /api/v1/assets", () => {
  it("returns a page and serializes timestamps as ISO strings", async () => {
    const page: AssetListPage = {
      assets: [sampleAsset],
      total: 1,
      page: 1,
      perPage: 20,
      pageCount: 1,
    };
    const res = await createApp({ core: stubCore(page) }).handle(
      new Request("http://localhost/api/v1/assets"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      assets: Array<{ id: number; createdAt: unknown; updatedAt: unknown }>;
    };
    expect(body.total).toBe(1);
    expect(body.assets[0]?.id).toBe(1);
    // Date -> ISO string over the wire (matches the AssetDto contract).
    expect(body.assets[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(body.assets[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("coerces and forwards page/per_page to the service", async () => {
    let received: ListAssetsOptions | undefined;
    const res = await createApp({
      core: stubCore(emptyPage, (options) => {
        received = options;
      }),
    }).handle(new Request("http://localhost/api/v1/assets?page=2&per_page=5"));

    expect(res.status).toBe(200);
    expect(received).toEqual({ page: 2, perPage: 5 });
  });

  it("rejects an out-of-range page with 422", async () => {
    const res = await createApp({ core: stubCore(emptyPage) }).handle(
      new Request("http://localhost/api/v1/assets?page=0"),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a fractional page with 422", async () => {
    const res = await createApp({ core: stubCore(emptyPage) }).handle(
      new Request("http://localhost/api/v1/assets?page=1.5"),
    );
    expect(res.status).toBe(422);
  });
});
