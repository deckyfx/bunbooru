import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, eventually, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/**
 * The favorites plugin end to end: its real migrations, its routes mounted on
 * the API, and its `fav:` metatag composed into Core search. Against the opt-in
 * test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("favorites plugin (integration)", () => {
  let live: LiveApi;
  let alice: { id: number; token: string };
  let bob: { id: number; token: string };
  let posts: [number, number, number];

  beforeAll(async () => {
    live = await bootLive(["favorites"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, favorites_posts RESTART IDENTITY CASCADE`,
    );
    alice = await live.user("alice");
    bob = await live.user("bob");
    posts = [await live.post("a", alice.id), await live.post("b", alice.id), await live.post("c", bob.id)];
  });

  const status = async (res: Response) => (await res.json()) as { count: number; favorited: boolean };
  const fav = (id: number, token: string, method: "PUT" | "DELETE" = "PUT") =>
    live.request(`/plugins/favorites/assets/${id}`, { method, token });

  it("favorites a post, idempotently, and reports count and the caller's state", async () => {
    expect(await status(await fav(posts[0], alice.token))).toEqual({ count: 1, favorited: true });
    expect(await status(await fav(posts[0], alice.token))).toEqual({ count: 1, favorited: true });
    expect(await status(await fav(posts[0], bob.token))).toEqual({ count: 2, favorited: true });

    const anon = await live.request(`/plugins/favorites/assets/${posts[0]}`);
    expect(await status(anon)).toEqual({ count: 2, favorited: false });
    const asBob = await live.request(`/plugins/favorites/assets/${posts[1]}`, { token: bob.token });
    expect(await status(asBob)).toEqual({ count: 0, favorited: false });
  });

  it("unfavorites only the caller's own favorite", async () => {
    await fav(posts[0], alice.token);
    await fav(posts[0], bob.token);
    expect(await status(await fav(posts[0], bob.token, "DELETE"))).toEqual({ count: 1, favorited: false });
    const asAlice = await live.request(`/plugins/favorites/assets/${posts[0]}`, { token: alice.token });
    expect(await status(asAlice)).toEqual({ count: 1, favorited: true });
  });

  it("requires a signed-in user to change favorites, and an existing post", async () => {
    expect((await live.request(`/plugins/favorites/assets/${posts[0]}`, { method: "PUT" })).status).toBe(401);
    expect((await fav(99_999, alice.token)).status).toBe(404);
    expect((await live.request("/plugins/favorites/assets/99999")).status).toBe(404);
  });

  it("drops a deleted post's favorites, keeping everyone else's", async () => {
    await fav(posts[0], alice.token);
    await fav(posts[0], bob.token);
    await fav(posts[1], alice.token);

    expect(await live.core.assetService.delete(posts[0], { deletedById: alice.id, reason: "" })).toBe(true);

    /** Favorite rows for one post, straight from the table. */
    const favCount = async (assetId: number) =>
      Number(
        [...(await live.db.execute<{ n: number | string }>(
          sql`SELECT count(*) AS n FROM favorites_posts WHERE asset_id = ${assetId}`,
        ))][0]?.n,
      );
    await eventually(async () => (await favCount(posts[0])) === 0);

    expect(await favCount(posts[0])).toBe(0);
    expect(await favCount(posts[1])).toBe(1);
  });

  it("fav:<user> finds a user's favorites and composes with other terms", async () => {
    await fav(posts[0], alice.token);
    await fav(posts[2], alice.token);
    await fav(posts[1], bob.token);
    const ids = async (q: string) => {
      const res = await live.request(`/assets?q=${encodeURIComponent(q)}`);
      return ((await res.json()) as { assets: { id: number }[] }).assets.map((a) => a.id).sort();
    };
    const byAlice = [posts[0], posts[2]].sort();
    expect(await ids("fav:alice")).toEqual(byAlice);
    expect(await ids("fav:ALICE")).toEqual(byAlice);
    expect(await ids("fav:alice -fav:bob user:bob")).toEqual([posts[2]]);
    expect(await ids("~fav:alice ~fav:bob")).toEqual([...posts].sort());
    expect(await ids("fav:nobody")).toEqual([]);
  });
});
