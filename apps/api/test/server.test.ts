import { describe, expect, it } from "bun:test";

import { app } from "../src/server";

/** Drive the app in-process — no port, no listen() — via Elysia's handle(). */
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
