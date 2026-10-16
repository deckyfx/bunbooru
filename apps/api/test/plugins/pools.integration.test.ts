import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/**
 * The pools plugin end to end: real migrations, routes on the API, and the
 * `pool:` metatag in Core search. Against the opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("pools plugin (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let alice: { id: number; token: string };
  let bob: { id: number; token: string };
  let posts: [number, number, number, number];

  beforeAll(async () => {
    live = await bootLive(["pools"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, pools_pools, pools_posts RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // first account → admin
    alice = await live.user("alice");
    bob = await live.user("bob");
    posts = [
      await live.post("p1", alice.id),
      await live.post("p2", alice.id),
      await live.post("p3", bob.id),
      await live.post("p4", bob.id),
    ];
  });

  const json = async <T>(res: Response) => (await res.json()) as T;
  const create = (name: string, token: string) =>
    live.request("/plugins/pools/pools", { method: "POST", token, body: JSON.stringify({ name }) });
  const add = (poolId: number, assetId: number, token: string) =>
    live.request(`/plugins/pools/pools/${poolId}/posts`, { method: "POST", token, body: JSON.stringify({ assetId }) });
  const order = async (poolId: number) =>
    (await json<{ posts: { id: number }[] }>(await live.request(`/plugins/pools/pools/${poolId}`))).posts.map((p) => p.id);

  it("creates a pool with a normalized name, and refuses a duplicate or numeric name", async () => {
    const res = await create("  My Comic  ", alice.token);
    expect(res.status).toBe(201);
    expect(await json<{ name: string; creatorName: string }>(res)).toMatchObject({
      name: "My_Comic",
      creatorName: "alice",
    });
    expect((await create("my_comic", bob.token)).status).toBe(409);
    expect((await create("12345", bob.token)).status).toBe(400);
    expect(
      (await live.request("/plugins/pools/pools", { method: "POST", body: JSON.stringify({ name: "x" }) })).status,
    ).toBe(401);
  });

  it("keeps posts in order: append, ignore a repeat, remove closes the gap, reorder replaces", async () => {
    const pool = await json<{ id: number }>(await create("series", alice.token));
    for (const id of [posts[0], posts[1], posts[2], posts[1]]) await add(pool.id, id, alice.token);
    expect(await order(pool.id)).toEqual([posts[0], posts[1], posts[2]]);

    await live.request(`/plugins/pools/pools/${pool.id}/posts/${posts[1]}`, { method: "DELETE", token: alice.token });
    expect(await order(pool.id)).toEqual([posts[0], posts[2]]);
    await add(pool.id, posts[3], alice.token); // lands at position 3, not 4
    const membership = await json<{ position: number; size: number }[]>(
      await live.request(`/plugins/pools/assets/${posts[3]}`),
    );
    expect(membership[0]).toMatchObject({ position: 3, size: 3 });

    const reorder = await live.request(`/plugins/pools/pools/${pool.id}/posts`, {
      method: "PUT",
      token: alice.token,
      body: JSON.stringify({ assetIds: [posts[3], posts[0], posts[2]] }),
    });
    expect(reorder.status).toBe(200);
    expect(await order(pool.id)).toEqual([posts[3], posts[0], posts[2]]);
  });

  it("refuses to add a post that doesn't exist", async () => {
    const pool = await json<{ id: number }>(await create("series", alice.token));
    expect((await add(pool.id, 99_999, alice.token)).status).toBe(404);
    const put = await live.request(`/plugins/pools/pools/${pool.id}/posts`, {
      method: "PUT",
      token: alice.token,
      body: JSON.stringify({ assetIds: [posts[0], 99_999] }),
    });
    expect(put.status).toBe(400);
  });

  it("lets only the creator or an admin change a pool", async () => {
    const pool = await json<{ id: number }>(await create("alices", alice.token));
    expect((await add(pool.id, posts[0], bob.token)).status).toBe(403);
    expect((await add(pool.id, posts[0], admin.token)).status).toBe(200);
    const rename = (token: string) =>
      live.request(`/plugins/pools/pools/${pool.id}`, { method: "PATCH", token, body: JSON.stringify({ name: "renamed" }) });
    expect((await rename(bob.token)).status).toBe(403);
    expect((await rename(alice.token)).status).toBe(200);

    const asBob = await json<{ canEdit: boolean }>(await live.request(`/plugins/pools/pools/${pool.id}`, { token: bob.token }));
    const asAlice = await json<{ canEdit: boolean }>(await live.request(`/plugins/pools/pools/${pool.id}`, { token: alice.token }));
    expect([asBob.canEdit, asAlice.canEdit]).toEqual([false, true]);

    expect((await live.request(`/plugins/pools/pools/${pool.id}`, { method: "DELETE", token: bob.token })).status).toBe(403);
    expect((await live.request(`/plugins/pools/pools/${pool.id}`, { method: "DELETE", token: alice.token })).status).toBe(204);
    expect((await live.request(`/plugins/pools/pools/${pool.id}`)).status).toBe(404);
  });

  it("gives a post's previous and next within each pool", async () => {
    const pool = await json<{ id: number }>(await create("strip", alice.token));
    for (const id of [posts[0], posts[1], posts[2]]) await add(pool.id, id, alice.token);
    const at = async (assetId: number) =>
      (await json<{ prevId: number | null; nextId: number | null }[]>(await live.request(`/plugins/pools/assets/${assetId}`)))[0];
    expect(await at(posts[0])).toMatchObject({ prevId: null, nextId: posts[1] });
    expect(await at(posts[1])).toMatchObject({ prevId: posts[0], nextId: posts[2] });
    expect(await at(posts[2])).toMatchObject({ prevId: posts[1], nextId: null });
    expect(await json<unknown[]>(await live.request(`/plugins/pools/assets/${posts[3]}`))).toEqual([]);
  });

  it("lists pools newest-updated first, filters by name, and pages", async () => {
    const a = await json<{ id: number }>(await create("first_pool", alice.token));
    await create("second_pool", alice.token);
    await create("other", bob.token);
    await add(a.id, posts[0], alice.token); // touching it makes it most recent
    const list = await json<{ pools: { name: string; postCount: number; coverAssetId: number | null }[] }>(
      await live.request("/plugins/pools/pools"),
    );
    expect(list.pools.map((p) => p.name)).toEqual(["first_pool", "other", "second_pool"]);
    expect(list.pools[0]).toMatchObject({ postCount: 1, coverAssetId: posts[0] });
    const filtered = await json<{ pools: { name: string }[] }>(await live.request("/plugins/pools/pools?q=pool"));
    expect(filtered.pools.map((p) => p.name).sort()).toEqual(["first_pool", "second_pool"]);
    expect((await live.request("/plugins/pools/pools?cursor=garbage")).status).toBe(400);
  });

  it("pool:<id> and pool:<name> find a pool's posts and compose with other terms", async () => {
    const pool = await json<{ id: number }>(await create("Comic_A", alice.token));
    for (const id of [posts[0], posts[2]]) await add(pool.id, id, alice.token);
    const ids = async (q: string) =>
      (await json<{ assets: { id: number }[] }>(await live.request(`/assets?q=${encodeURIComponent(q)}`))).assets
        .map((a) => a.id)
        .sort();
    const inPool = [posts[0], posts[2]].sort();
    expect(await ids(`pool:${pool.id}`)).toEqual(inPool);
    expect(await ids("pool:comic_a")).toEqual(inPool);
    expect(await ids("pool:comic_a user:bob")).toEqual([posts[2]]);
    expect(await ids("-pool:comic_a")).toEqual([posts[1], posts[3]].sort());
    expect(await ids("pool:missing")).toEqual([]);
  });

  it("returns the caller's own pools for Add to pool", async () => {
    await create("mine_b", alice.token);
    await create("mine_a", alice.token);
    await create("bobs", bob.token);
    const mine = await json<{ name: string }[]>(await live.request("/plugins/pools/mine", { token: alice.token }));
    expect(mine.map((p) => p.name)).toEqual(["mine_a", "mine_b"]);
    expect((await live.request("/plugins/pools/mine")).status).toBe(401);
  });
});
