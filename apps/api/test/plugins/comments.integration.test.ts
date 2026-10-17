import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, eventually, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/** A comment, as the plugin's routes return it. */
interface CommentBody {
  id: number;
  assetId: number;
  authorName: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  canEdit: boolean;
}

/** A page of a post's thread. */
interface ThreadPage {
  items: CommentBody[];
  nextAfter: number | null;
}

/** A page of the recent feed. */
interface RecentPage {
  items: CommentBody[];
  nextBefore: number | null;
}

/**
 * The comments plugin end to end: its real migrations, routes and
 * `asset.deleted` listener. Against the opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("comments plugin (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let member: { id: number; token: string };
  let other: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive(["comments"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, comments_comments, asset_tombstones RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // the first account is the admin
    member = await live.user("member");
    other = await live.user("other");
  });

  /** Comment on a post as `token` (the member by default; null for anonymous). */
  const comment = (assetId: number, body: Record<string, unknown>, token: string | null = member.token) =>
    live.request(`/plugins/comments/assets/${assetId}`, {
      method: "POST",
      token: token ?? undefined,
      body: JSON.stringify(body),
    });

  const posted = async (assetId: number, text: string, token = member.token): Promise<CommentBody> => {
    const res = await comment(assetId, { body: text }, token);
    expect(res.status).toBe(201);
    return (await res.json()) as CommentBody;
  };

  const thread = async (assetId: number, query = "", token?: string): Promise<ThreadPage> => {
    const res = await live.request(`/plugins/comments/assets/${assetId}${query}`, { token });
    expect(res.status).toBe(200);
    return (await res.json()) as ThreadPage;
  };

  /** Edit as `token` (the member by default; null for anonymous). */
  const edit = (id: number, body: Record<string, unknown>, token: string | null = member.token) =>
    live.request(`/plugins/comments/comments/${id}`, {
      method: "PATCH",
      token: token ?? undefined,
      body: JSON.stringify(body),
    });

  /** Delete as `token` (the member by default; null for anonymous). */
  const remove = (id: number, token: string | null = member.token) =>
    live.request(`/plugins/comments/comments/${id}`, { method: "DELETE", token: token ?? undefined });

  it("posts a trimmed comment", async () => {
    const id = await live.post("a", admin.id);
    const created = await posted(id, "  nice\npic  ");
    expect(created).toMatchObject({
      assetId: id,
      authorName: "member",
      body: "nice\npic",
      edited: false,
      canEdit: true,
    });
    expect(created).not.toHaveProperty("authorId");
  });

  it("refuses blank or overlong bodies, unknown posts and anonymous callers", async () => {
    const id = await live.post("b", admin.id);
    const blank = await comment(id, { body: "   \n " });
    expect(blank.status).toBe(400);
    expect(JSON.stringify(await blank.json())).toContain("can't be blank");
    expect((await comment(id, { body: "a".repeat(2001) })).status).toBe(400);
    expect((await comment(99_999, { body: "hi" })).status).toBe(404);
    expect((await comment(id, { body: "hi" }, null)).status).toBe(401);
  });

  it("lists a post's comments oldest first, in pages of 50", async () => {
    const id = await live.post("c", admin.id);
    const elsewhere = await live.post("d", admin.id);
    await live.db.execute(sql`
      INSERT INTO comments_comments (asset_id, author_id, author_name, body)
      SELECT ${id}, ${member.id}, 'member', 'comment ' || g FROM generate_series(1, 51) AS g
    `);
    await posted(elsewhere, "not this post");

    const first = await thread(id);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.body).toBe("comment 1");
    expect(first.items.every((item) => item.assetId === id)).toBe(true);
    // Anonymous: nobody's comment is editable.
    expect(first.items.some((item) => item.canEdit)).toBe(false);
    expect(first.nextAfter).toBe(50);

    const second = await thread(id, `?after=${first.nextAfter}`);
    expect(second.items.map((item) => item.body)).toEqual(["comment 51"]);
    expect(second.nextAfter).toBeNull();

    // canEdit follows the caller.
    expect((await thread(id, "", member.token)).items.every((item) => item.canEdit)).toBe(true);
    expect((await thread(id, "", other.token)).items.some((item) => item.canEdit)).toBe(false);
    expect((await thread(id, "", admin.token)).items.every((item) => item.canEdit)).toBe(true);
  });

  it("lets the author edit and delete their own comment", async () => {
    const id = await live.post("e", admin.id);
    const created = await posted(id, "frist");

    expect((await edit(created.id, { body: "  " })).status).toBe(400);
    const res = await edit(created.id, { body: " first " });
    expect(res.status).toBe(200);
    const edited = (await res.json()) as CommentBody;
    expect(edited).toMatchObject({ id: created.id, body: "first", edited: true });
    expect(new Date(edited.updatedAt).getTime()).toBeGreaterThan(new Date(created.createdAt).getTime());
    expect((await thread(id)).items.map((item) => item.body)).toEqual(["first"]);

    const gone = await remove(created.id);
    expect(gone.status).toBe(204);
    expect((await thread(id)).items).toEqual([]);
    expect((await remove(created.id)).status).toBe(404);
    expect((await edit(created.id, { body: "again" })).status).toBe(404);
  });

  it("refuses other members and anonymous callers, but lets an admin moderate", async () => {
    const id = await live.post("f", admin.id);
    const created = await posted(id, "mine");

    expect((await edit(created.id, { body: "hijacked" }, null)).status).toBe(401);
    expect((await remove(created.id, null)).status).toBe(401);
    expect((await edit(created.id, { body: "hijacked" }, other.token)).status).toBe(403);
    expect((await remove(created.id, other.token)).status).toBe(403);

    const moderated = await edit(created.id, { body: "[removed]" }, admin.token);
    expect(moderated.status).toBe(200);
    expect(((await moderated.json()) as CommentBody).authorName).toBe("member");
    expect((await remove(created.id, admin.token)).status).toBe(204);
  });

  it("serves the newest comments site-wide, in pages of 50", async () => {
    const a = await live.post("g", admin.id);
    const b = await live.post("h", admin.id);
    await live.db.execute(sql`
      INSERT INTO comments_comments (asset_id, author_id, author_name, body)
      SELECT CASE WHEN g % 2 = 0 THEN ${a} ELSE ${b} END, ${member.id}, 'member', 'comment ' || g
      FROM generate_series(1, 51) AS g
    `);

    const res = await live.request("/plugins/comments/recent");
    expect(res.status).toBe(200);
    const first = (await res.json()) as RecentPage;
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({ body: "comment 51", assetId: b });
    expect(first.items[1]).toMatchObject({ body: "comment 50", assetId: a });
    expect(first.nextBefore).toBe(2);

    const second = (await (await live.request(`/plugins/comments/recent?before=${first.nextBefore}`)).json()) as RecentPage;
    expect(second.items.map((item) => item.body)).toEqual(["comment 1"]);
    expect(second.nextBefore).toBeNull();
  });

  it("deletes a post's comments when the post is deleted", async () => {
    const id = await live.post("i", member.id);
    const kept = await live.post("j", member.id);
    await posted(id, "one");
    await posted(id, "two", other.token);
    await posted(kept, "stays");

    expect(await live.core.assetService.delete(id, { deletedById: admin.id, reason: "" })).toBe(true);

    const remaining = async () =>
      live.db.execute<{ asset_id: string }>(sql`SELECT asset_id FROM comments_comments`);
    await eventually(async () => (await remaining()).length === 1);
    const rows = await remaining();
    expect(rows.map((row) => Number(row.asset_id))).toEqual([kept]); // a raw bigint comes back as text
    expect((await thread(id)).items).toEqual([]);
  });
});
