import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, TEST_DATABASE_URL, uniqueImage, type LiveApi } from "./plugins/live-harness";

/**
 * Upload-scoped API keys over the real app: they may add posts and nothing
 * else, on Core routes and plugin routes alike. Against the opt-in test
 * database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("upload-scoped API keys (integration)", () => {
  let live: LiveApi;
  let session: string;
  let uploadKey: string;

  beforeAll(async () => {
    live = await bootLive(["favorites"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, api_keys, favorites_posts RESTART IDENTITY CASCADE`,
    );
    ({ token: session } = await live.user("alice"));
    const minted = await live.request("/account/api-keys", {
      method: "POST",
      token: session,
      body: JSON.stringify({ name: "phone", scope: "upload" }),
    });
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as { key: string; scope: string };
    expect(body.scope).toBe("upload");
    uploadKey = body.key;
  });

  const upload = (label: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("file", new File([uniqueImage(label)], "a.png", { type: "image/png" }));
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return live.request("/assets", { method: "POST", token: uploadKey, body: form });
  };

  it("uploads, with tags applied to the new post", async () => {
    const res = await upload("a", { tags: "cat  sky", source: "https://example.com/a" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    const tags = (await (await live.request(`/assets/${id}/tags`)).json()) as { name: string }[];
    expect(tags.map((t) => t.name).sort()).toEqual(["cat", "sky"]);

    // A dedupe hit is someone's existing post: its tags are left alone.
    expect((await upload("a", { tags: "dog" })).status).toBe(200);
    const after = (await (await live.request(`/assets/${id}/tags`)).json()) as { name: string }[];
    expect(after.map((t) => t.name).sort()).toEqual(["cat", "sky"]);
  });

  it("may check who it belongs to and look up tags, but nothing else", async () => {
    expect((await live.request("/auth/me", { token: uploadKey })).status).toBe(200);
    expect((await live.request("/tags?q=c", { token: uploadKey })).status).toBe(200);

    const { id } = (await (await upload("b")).json()) as { id: number };
    for (const [path, method, body] of [
      ["/assets", "GET", undefined],
      [`/assets/${id}`, "PATCH", JSON.stringify({ rating: "s" })],
      [`/assets/${id}/tags`, "PATCH", JSON.stringify({ tags: ["x"] })],
      ["/account/api-keys", "POST", JSON.stringify({ name: "escalate" })],
      ["/account/api-keys", "GET", undefined],
    ] as const) {
      const res = await live.request(path, { method, token: uploadKey, ...(body ? { body } : {}) });
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 });
    }
  });

  it("is no credential at all to a plugin route", async () => {
    const { id } = (await (await upload("c")).json()) as { id: number };
    expect((await live.request(`/plugins/favorites/assets/${id}`, { method: "PUT", token: uploadKey })).status).toBe(
      401,
    );
    expect((await live.request(`/plugins/favorites/assets/${id}`, { method: "PUT", token: session })).status).toBe(
      200,
    );
  });

  it("rejects an unknown scope, and defaults to full", async () => {
    const bad = await live.request("/account/api-keys", {
      method: "POST",
      token: session,
      body: JSON.stringify({ name: "x", scope: "admin" }),
    });
    expect(bad.status).toBe(422);
    const full = (await (
      await live.request("/account/api-keys", { method: "POST", token: session, body: JSON.stringify({ name: "y" }) })
    ).json()) as { scope: string; key: string };
    expect(full.scope).toBe("full");
    expect((await live.request("/assets", { token: full.key })).status).toBe(200);
  });
});
