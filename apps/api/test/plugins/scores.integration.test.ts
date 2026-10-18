import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, eventually, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/** A post's score, as the plugin's routes return it. */
interface ScoreBody {
  score: number;
  up: number;
  down: number;
  mine: -1 | 0 | 1;
}

/**
 * The scores plugin end to end: its real migrations, its routes, the totals
 * kept in step with the votes (under concurrency too), its `score:` metatag
 * composed into Core search, and its `asset.deleted` cleanup. Against the
 * opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("scores plugin (integration)", () => {
  let live: LiveApi;
  let alice: { id: number; token: string };
  let bob: { id: number; token: string };
  let posts: [number, number, number];

  beforeAll(async () => {
    live = await bootLive(["scores"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, asset_tombstones, scores_votes, scores_totals RESTART IDENTITY CASCADE`,
    );
    alice = await live.user("alice");
    bob = await live.user("bob");
    posts = [await live.post("a", alice.id), await live.post("b", alice.id), await live.post("c", bob.id)];
  });

  const vote = (id: number, value: unknown, token: string | undefined) =>
    live.request(`/plugins/scores/assets/${id}`, { method: "PUT", token, body: JSON.stringify({ value }) });
  const body = async (res: Response): Promise<ScoreBody> => {
    expect(res.status).toBe(200);
    return (await res.json()) as ScoreBody;
  };
  const read = async (id: number, token?: string) =>
    body(await live.request(`/plugins/scores/assets/${id}`, { token }));

  /** A post's vote and totals rows, straight from the tables. */
  const rows = async (assetId: number) => {
    const [counted] = [
      ...(await live.db.execute<{ votes: number | string; totals: number | string }>(
        sql`SELECT (SELECT count(*) FROM scores_votes WHERE asset_id = ${assetId}) AS votes,
                   (SELECT count(*) FROM scores_totals WHERE asset_id = ${assetId}) AS totals`,
      )),
    ];
    return { votes: Number(counted?.votes), totals: Number(counted?.totals) };
  };

  it("scores an unvoted post 0/0/0", async () => {
    expect(await read(posts[0])).toEqual({ score: 0, up: 0, down: 0, mine: 0 });
    expect(await read(posts[0], alice.token)).toEqual({ score: 0, up: 0, down: 0, mine: 0 });
  });

  it("votes up, down, changes and removes a vote, keeping the totals in step", async () => {
    expect(await body(await vote(posts[0], 1, alice.token))).toEqual({ score: 1, up: 1, down: 0, mine: 1 });
    // The same vote again changes nothing.
    expect(await body(await vote(posts[0], 1, alice.token))).toEqual({ score: 1, up: 1, down: 0, mine: 1 });
    expect(await body(await vote(posts[0], -1, bob.token))).toEqual({ score: 0, up: 1, down: 1, mine: -1 });
    // Alice changes her mind.
    expect(await body(await vote(posts[0], -1, alice.token))).toEqual({ score: -2, up: 0, down: 2, mine: -1 });
    // Bob takes his vote back; removing a vote that isn't there is harmless.
    expect(await body(await vote(posts[0], 0, bob.token))).toEqual({ score: -1, up: 0, down: 1, mine: 0 });
    expect(await body(await vote(posts[0], 0, bob.token))).toEqual({ score: -1, up: 0, down: 1, mine: 0 });
    // Other posts are untouched.
    expect(await read(posts[1])).toEqual({ score: 0, up: 0, down: 0, mine: 0 });
  });

  it("reports each viewer's own vote, and none for anonymous", async () => {
    await vote(posts[0], 1, alice.token);
    await vote(posts[0], -1, bob.token);
    expect((await read(posts[0], alice.token)).mine).toBe(1);
    expect((await read(posts[0], bob.token)).mine).toBe(-1);
    expect(await read(posts[0])).toEqual({ score: 0, up: 1, down: 1, mine: 0 });
  });

  it("allows voting on your own post", async () => {
    expect(await body(await vote(posts[0], 1, alice.token))).toMatchObject({ score: 1, mine: 1 });
  });

  it("requires a signed-in user, an existing post and a valid vote", async () => {
    expect((await vote(posts[0], 1, undefined)).status).toBe(401);
    expect((await vote(99_999, 1, alice.token)).status).toBe(404);
    expect((await live.request("/plugins/scores/assets/99999")).status).toBe(404);
    for (const bad of [2, -2, 0.5, "1", null]) {
      expect([400, 422]).toContain((await vote(posts[0], bad, alice.token)).status);
    }
    expect(await read(posts[0])).toEqual({ score: 0, up: 0, down: 0, mine: 0 });
  });

  it("keeps the total exact when many users vote on one post at once", async () => {
    const voters = await Promise.all(Array.from({ length: 16 }, (_, i) => live.user(`voter${i}`)));
    // Everyone votes at once: even-numbered voters up, odd down; then, again
    // all at once, every third voter flips their vote and every fifth retracts.
    const first = (i: number) => (i % 2 === 0 ? 1 : -1);
    await Promise.all(voters.map((v, i) => vote(posts[0], first(i), v.token).then(body)));
    const second = voters.map((_, i) => (i % 5 === 0 ? 0 : i % 3 === 0 ? -first(i) : first(i)));
    await Promise.all(voters.map((v, i) => vote(posts[0], second[i], v.token).then(body)));

    const up = second.filter((v) => v === 1).length;
    const down = second.filter((v) => v === -1).length;
    expect(await read(posts[0])).toEqual({ score: up - down, up, down, mine: 0 });

    const [sums] = [
      ...(await live.db.execute<{ score: number | string; n: number | string }>(
        sql`SELECT coalesce(sum(value), 0) AS score, count(*) AS n FROM scores_votes WHERE asset_id = ${posts[0]}`,
      )),
    ];
    expect(Number(sums?.score)).toBe(up - down);
    expect(Number(sums?.n)).toBe(up + down);
  });

  it("keeps the total exact when one user fires conflicting votes at once (a double click)", async () => {
    const values = [1, 1, -1, 1, 0, -1, 1, 1, -1, 0, 1, 1] as const;
    await Promise.all(values.map((value) => vote(posts[1], value, alice.token).then(body)));
    // Whichever request committed last decides the vote; the total must match it.
    const after = await read(posts[1], alice.token);
    expect(after.score).toBe(after.mine);
    expect(after.up).toBe(after.mine === 1 ? 1 : 0);
    expect(after.down).toBe(after.mine === -1 ? 1 : 0);
  });

  it("searches by score with score:, counting unvoted posts as 0", async () => {
    await vote(posts[0], 1, alice.token);
    await vote(posts[0], 1, bob.token); // posts[0]: 2
    await vote(posts[1], -1, alice.token); // posts[1]: -1
    // posts[2] has no votes: 0. A vote and its retraction leave a 0 row too.
    await vote(posts[2], 1, alice.token);
    await vote(posts[2], 0, alice.token);

    const ids = async (q: string) => {
      const res = await live.request(`/assets?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { assets: { id: number }[] }).assets.map((a) => a.id).sort((a, b) => a - b);
    };
    const all = [...posts].sort((a, b) => a - b);

    expect(await ids("score:>0")).toEqual([posts[0]]);
    expect(await ids("score:2")).toEqual([posts[0]]);
    expect(await ids("score:0")).toEqual([posts[2]]);
    expect(await ids("score:<0")).toEqual([posts[1]]);
    expect(await ids("score:>=0")).toEqual([posts[0], posts[2]].sort((a, b) => a - b));
    expect(await ids("score:<=0")).toEqual([posts[1], posts[2]].sort((a, b) => a - b));
    expect(await ids("score:0..5")).toEqual([posts[0], posts[2]].sort((a, b) => a - b));
    expect(await ids("score:1..5")).toEqual([posts[0]]);
    expect(await ids("score:-1..1")).toEqual([posts[1], posts[2]].sort((a, b) => a - b));
    expect(await ids("score:..-1")).toEqual([posts[1]]);
    expect(await ids("-score:0")).toEqual([posts[0], posts[1]].sort((a, b) => a - b));
    expect(await ids("score:>0 user:bob")).toEqual([]);
    // Bounds beyond the int column compare cleanly; non-integers are ignored.
    expect(await ids("score:>99999999999")).toEqual([]);
    expect(await ids("score:<99999999999")).toEqual(all);
    expect(await ids("score:1.5")).toEqual(all);
    expect(await ids("score:abc")).toEqual(all);
  });

  describe("order:score", () => {
    /** The listing for `q`, one page of `perPage` (default 100), from `cursor`. */
    const list = async (q: string, { perPage = 100, cursor }: { perPage?: number; cursor?: string } = {}) => {
      const params = new URLSearchParams({ q, per_page: String(perPage), ...(cursor ? { cursor } : {}) });
      const res = await live.request(`/assets?${params}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { assets: { id: number }[]; nextCursor: string | null; prevCursor: string | null };
    };
    const ids = async (q: string) => (await list(q)).assets.map((a) => a.id);

    /** Six posts: scores 2, -1, 0 (a retracted vote's 0 row), 1, 1, and unvoted (0). */
    let all: number[];
    let highestFirst: number[];
    beforeEach(async () => {
      const [p3, p4, p5] = [await live.post("d", bob.id), await live.post("e", bob.id), await live.post("f", alice.id)];
      all = [...posts, p3, p4, p5];
      await vote(posts[0], 1, alice.token);
      await vote(posts[0], 1, bob.token); // 2
      await vote(posts[1], -1, alice.token); // -1
      await vote(posts[2], 1, alice.token);
      await vote(posts[2], 0, alice.token); // 0, with a totals row
      await vote(p3, 1, bob.token); // 1
      await vote(p4, 1, alice.token); // 1, tied with p3: the higher id first
      // p5 is unvoted: 0, tied with posts[2].
      highestFirst = [posts[0], p4, p3, p5, posts[2], posts[1]];
    });

    it("sorts highest first with order:score (and _desc), lowest first with order:score_asc", async () => {
      expect(await ids("order:score")).toEqual(highestFirst);
      expect(await ids("order:score_desc")).toEqual(highestFirst);
      expect(await ids("order:SCORE")).toEqual(highestFirst);
      // Ascending flips the id tiebreak too: a true reverse.
      expect(await ids("order:score_asc")).toEqual([...highestFirst].reverse());
    });

    it("pages through every post exactly once, in order, both ways", async () => {
      for (const q of ["order:score", "order:score_asc"]) {
        const expected = q === "order:score" ? highestFirst : [...highestFirst].reverse();
        const pages: number[][] = [];
        let page = await list(q, { perPage: 4 });
        pages.push(page.assets.map((a) => a.id));
        expect(page.prevCursor).toBeNull();
        for (let guard = 0; page.nextCursor && guard < 10; guard++) {
          page = await list(q, { perPage: 4, cursor: page.nextCursor });
          pages.push(page.assets.map((a) => a.id));
        }
        expect(pages.flat()).toEqual(expected);

        // With pages of 2: forward to the end, then back to the (real) first page.
        const forward: number[] = [];
        let small = await list(q, { perPage: 2 });
        forward.push(...small.assets.map((a) => a.id));
        while (small.nextCursor) {
          small = await list(q, { perPage: 2, cursor: small.nextCursor });
          forward.push(...small.assets.map((a) => a.id));
        }
        expect(forward).toEqual(expected);
        const backward: number[][] = [];
        while (small.prevCursor) {
          small = await list(q, { perPage: 2, cursor: small.prevCursor });
          backward.push(small.assets.map((a) => a.id));
        }
        expect(backward).toEqual([expected.slice(2, 4), expected.slice(0, 2)]);
      }
    });

    it("combines with a filter", async () => {
      expect(await ids("score:>0 order:score")).toEqual(highestFirst.slice(0, 3));
      expect(await ids("score:<=0 order:score_asc")).toEqual([posts[1], posts[2], all[5]!]);
      expect(await ids("user:bob order:score")).toEqual([all[4]!, all[3]!, posts[2]]);
    });

    it("refuses an order:score cursor under another order", async () => {
      const { nextCursor } = await list("order:score", { perPage: 2 });
      const params = new URLSearchParams({ q: "order:views", per_page: "2", cursor: nextCursor! });
      expect((await live.request(`/assets?${params}`)).status).toBe(400);
    });

    it("falls back to the default order while the plugin is inactive", async () => {
      const newestFirst = [...all].sort((a, b) => b - a);
      const { nextCursor } = await list("order:score", { perPage: 2 });
      await live.host.deactivate("scores");
      try {
        expect(live.core.sortProviders.get("score")).toBeUndefined();
        expect(await ids("order:score")).toEqual(newestFirst);
        // An outstanding cursor no longer fits the order it would get.
        const params = new URLSearchParams({ q: "order:score", per_page: "2", cursor: nextCursor! });
        expect((await live.request(`/assets?${params}`)).status).toBe(400);
      } finally {
        await live.host.activate("scores");
      }
      expect(await ids("order:score")).toEqual(highestFirst);
    });
  });

  it("drops a deleted post's votes and total, keeping everyone else's", async () => {
    await vote(posts[0], 1, alice.token);
    await vote(posts[0], -1, bob.token);
    await vote(posts[1], 1, alice.token);

    expect(await live.core.assetService.delete(posts[0], { deletedById: alice.id, reason: "" })).toBe(true);
    await eventually(async () => {
      const left = await rows(posts[0]);
      return left.votes === 0 && left.totals === 0;
    });

    expect(await rows(posts[0])).toEqual({ votes: 0, totals: 0 });
    expect(await rows(posts[1])).toEqual({ votes: 1, totals: 1 });
    expect((await vote(posts[0], 1, alice.token)).status).toBe(404);
  });
});
