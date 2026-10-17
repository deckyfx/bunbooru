import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/** A page, as the plugin's routes return it. */
interface PageBody {
  title: string;
  body: string;
  version: number;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A page of the index. */
interface IndexPage {
  items: { title: string; version: number; updatedByName: string | null; updatedAt: string }[];
  nextAfter: string | null;
}

/** A page of a page's history. */
interface HistoryPage {
  items: { version: number; editorName: string | null; length: number; createdAt: string }[];
  nextBefore: number | null;
}

/**
 * The wiki plugin end to end: its real migrations and routes. Against the
 * opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("wiki plugin (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let member: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive(["wiki"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE users, sessions, wiki_pages, wiki_page_versions RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // the first account is the admin
    member = await live.user("member");
  });

  /** The path of a page (and an optional sub-resource), with the title URL-encoded. */
  const pagePath = (title: string, rest = "") => `/plugins/wiki/pages/${encodeURIComponent(title)}${rest}`;

  /** Save a page as `token` (the member by default; null for anonymous). */
  const put = (title: string, body: Record<string, unknown>, token: string | null = member.token) =>
    live.request(pagePath(title), { method: "PUT", token: token ?? undefined, body: JSON.stringify(body) });

  const saved = async (title: string, body: Record<string, unknown>, token = member.token): Promise<PageBody> => {
    const res = await put(title, body, token);
    expect(res.status).toBe(200);
    return (await res.json()) as PageBody;
  };

  const get = (title: string) => live.request(pagePath(title));

  const history = async (title: string, query = ""): Promise<HistoryPage> => {
    const res = await live.request(pagePath(title, `/history${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as HistoryPage;
  };

  const index = async (query = ""): Promise<IndexPage> => {
    const res = await live.request(`/plugins/wiki/pages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as IndexPage;
  };

  const revert = (title: string, version: number, token: string | null) =>
    live.request(pagePath(title, "/revert"), {
      method: "POST",
      token: token ?? undefined,
      body: JSON.stringify({ version }),
    });

  it("creates, reads and edits a page, writing a version per edit", async () => {
    const created = await saved("Blue Sky", { body: "  A clear [[sky]].  " });
    expect(created).toMatchObject({ title: "blue_sky", body: "A clear [[sky]].", version: 1, updatedByName: "member" });

    // Any spelling of the title reaches the same page.
    const read = await get("BLUE  sky");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ title: "blue_sky", version: 1 });

    const edited = await saved("blue_sky", { body: "A cloudless sky.", baseVersion: 1 }, admin.token);
    expect(edited).toMatchObject({ version: 2, body: "A cloudless sky.", updatedByName: "admin" });

    // Saving the same text again writes nothing.
    expect(await saved("blue_sky", { body: "A cloudless sky." })).toMatchObject({ version: 2 });

    const { items } = await history("blue_sky");
    expect(items.map((v) => [v.version, v.editorName, v.length])).toEqual([
      [2, "admin", 16],
      [1, "member", 16],
    ]);
    const old = await live.request(pagePath("blue_sky", "/versions/1"));
    expect(await old.json()).toMatchObject({ title: "blue_sky", version: 1, body: "A clear [[sky]]." });
    expect((await live.request(pagePath("blue_sky", "/versions/3"))).status).toBe(404);
  });

  it("is 404 for a missing page or one whose title can't exist", async () => {
    expect((await get("nothing_here")).status).toBe(404);
    expect((await get("a*")).status).toBe(404);
    expect((await live.request(pagePath("nothing_here", "/history"))).status).toBe(404);
  });

  it("refuses a stale baseVersion with 409, writing nothing", async () => {
    await saved("cat", { body: "first" });
    await saved("cat", { body: "second", baseVersion: 1 }, admin.token);

    const stale = await put("cat", { body: "my edit from v1", baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toContain("changed since you opened it");

    // Creating a page that already exists is stale too (baseVersion 0 = "new").
    expect((await put("cat", { body: "new?", baseVersion: 0 })).status).toBe(409);
    // ...and editing one that no longer exists.
    expect((await put("gone", { body: "x", baseVersion: 3 })).status).toBe(409);
    expect((await get("gone")).status).toBe(404);

    const page = (await (await get("cat")).json()) as PageBody;
    expect(page).toMatchObject({ version: 2, body: "second" });
    // Without a baseVersion, the edit simply lands.
    expect(await saved("cat", { body: "third" })).toMatchObject({ version: 3 });
  });

  it("handles titles with URL-special characters", async () => {
    for (const title of ["ac/dc", "what?", "50%", "a#b&c=d", "über"]) {
      expect(await saved(title, { body: `About ${title}` })).toMatchObject({ title, version: 1 });
      const res = await get(title);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ title, body: `About ${title}` });
      expect((await history(title)).items).toHaveLength(1);
    }
  });

  it("validates the title and body of an edit", async () => {
    expect((await put("a*", { body: "x" })).status).toBe(400);
    expect((await put("x".repeat(101), { body: "x" })).status).toBe(400);
    const blank = await put("cat", { body: "  \n " });
    expect(blank.status).toBe(400);
    expect(JSON.stringify(await blank.json())).toContain("can't be blank");
    expect((await put("cat", { body: "a".repeat(20_001) })).status).toBe(400);
    expect((await put("cat", { body: "a".repeat(20_000) })).status).toBe(200);
  });

  it("refuses an anonymous edit with 401", async () => {
    expect((await put("cat", { body: "hi" }, null)).status).toBe(401);
    expect((await get("cat")).status).toBe(404);
  });

  it("pages a page's history newest first, 50 at a time", async () => {
    await saved("long", { body: "v1" });
    // Versions 2..60 straight into the table, then the page to match.
    await live.db.execute(sql`
      INSERT INTO wiki_page_versions (page_id, version, title, body, editor_name)
      SELECT p.id, g, 'long', 'v' || g, 'member'
      FROM wiki_pages p CROSS JOIN generate_series(2, 60) AS g WHERE p.title = 'long'
    `);
    await live.db.execute(sql`UPDATE wiki_pages SET version = 60, body = 'v60' WHERE title = 'long'`);

    const first = await history("long");
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.version).toBe(60);
    expect(first.items.at(-1)?.version).toBe(11);
    expect(first.nextBefore).toBe(11);

    const second = await history("long", `?before=${first.nextBefore}`);
    expect(second.items.map((v) => v.version)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(second.nextBefore).toBeNull();
  });

  it("reverts as an admin by writing a new version; a member gets 403", async () => {
    await saved("dog", { body: "good text" });
    await saved("dog", { body: "vandalism" });

    expect((await revert("dog", 1, member.token)).status).toBe(403);
    expect((await revert("dog", 1, null)).status).toBe(401);
    expect((await revert("dog", 9, admin.token)).status).toBe(404);
    expect((await revert("missing", 1, admin.token)).status).toBe(404);

    const res = await revert("dog", 1, admin.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 3, body: "good text", updatedByName: "admin" });

    // History is appended to, never rewritten.
    const { items } = await history("dog");
    expect(items.map((v) => [v.version, v.editorName])).toEqual([
      [3, "admin"],
      [2, "member"],
      [1, "member"],
    ]);
  });

  it("deletes a page and its history as an admin", async () => {
    await saved("ac/dc", { body: "a band" });
    await saved("ac/dc", { body: "a rock band" });

    const del = (title: string, token: string | null) =>
      live.request(pagePath(title), { method: "DELETE", token: token ?? undefined });
    expect((await del("ac/dc", member.token)).status).toBe(403);
    expect((await del("ac/dc", null)).status).toBe(401);
    expect((await del("ac/dc", admin.token)).status).toBe(204);
    expect((await del("ac/dc", admin.token)).status).toBe(404);
    expect((await get("ac/dc")).status).toBe(404);

    const versions = await live.db.execute(sql`SELECT count(*)::int AS n FROM wiki_page_versions`);
    expect([...versions]).toEqual([{ n: 0 }]);
  });

  it("lists pages alphabetically, by title prefix, 50 at a time", async () => {
    for (const title of ["blue_sky", "blue_eyes", "red_hair", "ac/dc", "blue%"]) {
      await saved(title, { body: `About ${title}` });
    }

    const all = await index();
    expect(all.items.map((p) => p.title)).toEqual(["ac/dc", "blue%", "blue_eyes", "blue_sky", "red_hair"]);
    expect(all.items[0]).toMatchObject({ version: 1, updatedByName: "member" });
    expect(all.items[0]).not.toHaveProperty("body");
    expect(all.nextAfter).toBeNull();

    // A prefix is normalized like a title, and its LIKE metacharacters are literal.
    expect((await index("?q=Blue")).items.map((p) => p.title)).toEqual(["blue%", "blue_eyes", "blue_sky"]);
    expect((await index("?q=BLUE%20S")).items.map((p) => p.title)).toEqual(["blue_sky"]);
    expect((await index("?q=blue_")).items.map((p) => p.title)).toEqual(["blue_eyes", "blue_sky"]);
    expect((await index(`?q=${encodeURIComponent("blue%")}`)).items.map((p) => p.title)).toEqual(["blue%"]);
    expect((await index("?q=green")).items).toEqual([]);

    await live.db.execute(sql`
      INSERT INTO wiki_pages (title, body, version, updated_by_name)
      SELECT 'tag_' || lpad(g::text, 3, '0'), 'x', 1, 'member' FROM generate_series(1, 60) AS g
    `);
    const first = await index("?q=tag_");
    expect(first.items).toHaveLength(50);
    expect(first.nextAfter).toBe("tag_050");
    const second = await index(`?q=tag_&after=${encodeURIComponent("tag_050")}`);
    expect(second.items.map((p) => p.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `tag_${String(51 + i).padStart(3, "0")}`),
    );
    expect(second.nextAfter).toBeNull();
  });

  it("refuses a NUL character with a 400, on plugin and Core routes alike", async () => {
    // Postgres text can't store U+0000: without the API's guard this was a 500.
    const res = await put("cat", { body: "a\u0000b" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("NUL");

    const id = await live.post("nul", member.id);
    const core = await live.request(`/assets/${id}`, {
      method: "PATCH",
      token: member.token,
      body: JSON.stringify({ source: "https://example.com/\u0000" }),
    });
    expect(core.status).toBe(400);
  });
});
