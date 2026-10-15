import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebRoutes, type WebAsset } from "../../src/web/routes";

/** A throwaway "dist" standing in for the files embedded in the binary. */
let dir: string;
let assets: WebAsset[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bunbooru-web-"));
  // [name, contents, immutable]: what the build records from the bundler's
  // output. `app.js` stands in for a stable-named output a build option could emit.
  const files: [string, string, boolean][] = [
    ["index.html", "<!doctype html><title>shell</title>", false],
    ["chunk-abc123.js", "console.log(1)", true],
    ["chunk-def456.css", "body{}", true],
    ["app.js", "console.log(2)", false],
  ];
  assets = [];
  for (const [name, contents, immutable] of files) {
    await Bun.write(join(dir, name), contents);
    assets.push({ urlPath: `/${name}`, file: join(dir, name), immutable });
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Elysia's fast path needs a real-looking host (it mis-slices `http://x/…`). */
function get(app: { handle(req: Request): Promise<Response> }, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`));
}

describe("createWebRoutes", () => {
  it("mounts nothing when no assets are embedded (running from source)", async () => {
    const res = await get(createWebRoutes([]), "/");
    expect(res.status).toBe(404);
  });

  it("refuses an asset set without index.html", () => {
    expect(() =>
      createWebRoutes([{ urlPath: "/chunk.js", file: "/nope", immutable: true }]),
    ).toThrow(/index\.html/);
  });

  it("serves a content-hashed file at its exact path, cached forever with its content type", async () => {
    const res = await get(createWebRoutes(assets), "/chunk-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("revalidates an embedded file whose name is not content-hashed", async () => {
    const res = await get(createWebRoutes(assets), "/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(2)");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it.each(["/", "/posts/12", "/admin/extensions", "/index.html"])(
    "answers %s with the revalidated SPA shell",
    async (path) => {
      const res = await get(createWebRoutes(assets), path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>shell</title>");
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    },
  );

  it.each(["/api", "/api/", "/api/v1/nope", "/api/v2/anything"])(
    "404s %s instead of returning HTML",
    async (path) => {
      const res = await get(createWebRoutes(assets), path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toStartWith("text/html");
    },
  );

  it.each(["/chunk-stale999.js", "/chunk-stale999.css", "/favicon-old.svg"])(
    "404s the missing asset %s rather than answering it with HTML",
    async (path) => {
      const res = await get(createWebRoutes(assets), path);
      expect(res.status).toBe(404);
    },
  );

  it.each(["/tags/k.o", "/posts/st._louis"])(
    "still answers the dotted client route %s with the SPA shell",
    async (path) => {
      const res = await get(createWebRoutes(assets), path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>shell</title>");
    },
  );

  it("does not treat a path that merely starts with 'api' as the API", async () => {
    const res = await get(createWebRoutes(assets), "/apiary");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>shell</title>");
  });
});
