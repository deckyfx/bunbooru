import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, TEST_DATABASE_URL, uniqueImage, type LiveApi } from "./plugins/live-harness";

/**
 * `DELETE /api/v1/assets/:id` over the real Core: the uploader or an admin may
 * delete, the post and its file go, a tombstone stays, and the same bytes can
 * be uploaded again as a new post. Against the opt-in test database (it
 * TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("post deletion (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let alice: { id: number; token: string };
  let bob: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive([]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, asset_tombstones RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // first account → admin
    alice = await live.user("alice");
    bob = await live.user("bob");
  });

  const remove = (id: number, token: string, reason?: string) =>
    live.request(`/assets/${id}`, {
      method: "DELETE",
      token,
      ...(reason === undefined ? {} : { body: JSON.stringify({ reason }) }),
    });

  /** Upload `label`'s bytes over HTTP as `token`. */
  const upload = (label: string, token: string) => {
    const form = new FormData();
    form.append("file", new File([uniqueImage(label)], "a.png", { type: "image/png" }));
    return live.request("/assets", { method: "POST", token, body: form });
  };

  /** Tombstone rows for one old post id. */
  const tombstones = async (assetId: number) =>
    [
      ...(await live.db.execute<{ sha256: string; deleted_by_id: number | string | null; reason: string }>(
        sql`SELECT sha256, deleted_by_id, reason FROM asset_tombstones WHERE asset_id = ${assetId}`,
      )),
    ].map((row) => ({ sha256: row.sha256, deletedById: Number(row.deleted_by_id), reason: row.reason }));

  it("lets the uploader delete their own post: 204, then 404, file gone, tombstone kept", async () => {
    const created = await upload("mine", alice.token);
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: number; sha256: string; storageKey: string };
    expect(await live.storage.exists(post.storageKey)).toBe(true);

    const res = await remove(post.id, alice.token, "wrong crop");
    expect(res.status).toBe(204);

    expect((await live.request(`/assets/${post.id}`)).status).toBe(404);
    expect((await live.request(`/assets/${post.id}/file`)).status).toBe(404);
    expect(await live.storage.exists(post.storageKey)).toBe(false);
    expect(await tombstones(post.id)).toEqual([
      { sha256: post.sha256, deletedById: alice.id, reason: "wrong crop" },
    ]);
  });

  it("refuses another member (403), and lets an admin delete anyone's post", async () => {
    const id = await live.post("alices", alice.id);

    expect((await remove(id, bob.token)).status).toBe(403);
    expect((await live.request(`/assets/${id}`)).status).toBe(200);

    expect((await remove(id, admin.token)).status).toBe(204);
    expect((await live.request(`/assets/${id}`)).status).toBe(404);
    expect(await tombstones(id)).toEqual([
      { sha256: expect.any(String), deletedById: admin.id, reason: "" },
    ]);
  });

  it("404 for an unknown post, 401 when signed out", async () => {
    expect((await remove(99_999, alice.token)).status).toBe(404);
    const id = await live.post("anon", alice.id);
    expect((await live.request(`/assets/${id}`, { method: "DELETE" })).status).toBe(401);
  });

  it("re-uploading the same bytes after deletion makes a new post (201)", async () => {
    const first = (await (await upload("again", alice.token)).json()) as { id: number; sha256: string };
    expect((await remove(first.id, alice.token)).status).toBe(204);

    const again = await upload("again", alice.token);
    expect(again.status).toBe(201);
    const second = (await again.json()) as { id: number; sha256: string };
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect((await live.request(`/assets/${second.id}/file`)).status).toBe(200);
  });
});
