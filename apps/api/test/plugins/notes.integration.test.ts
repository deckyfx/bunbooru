import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, eventually, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/** A note, as the plugin's routes return it. */
interface NoteBody {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  body: string;
  authorName: string | null;
  updatedAt: string;
  canEdit: boolean;
}

/** A box over the image, in fractions. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BOX: Box = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };

/**
 * The notes plugin end to end: its real migrations, routes and
 * `asset.deleted` listener. Against the opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("notes plugin (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let member: { id: number; token: string };
  let other: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive(["notes"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, notes_notes, asset_tombstones RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // the first account is the admin
    member = await live.user("member");
    other = await live.user("other");
  });

  /** Add a note as `token` (the member by default; null for anonymous). */
  const add = (assetId: number, body: Record<string, unknown>, token: string | null = member.token) =>
    live.request(`/plugins/notes/assets/${assetId}`, {
      method: "POST",
      token: token ?? undefined,
      body: JSON.stringify(body),
    });

  const added = async (assetId: number, text: string, box: Box = BOX, token = member.token): Promise<NoteBody> => {
    const res = await add(assetId, { ...box, body: text }, token);
    expect(res.status).toBe(201);
    return (await res.json()) as NoteBody;
  };

  const list = async (assetId: number, token?: string): Promise<NoteBody[]> => {
    const res = await live.request(`/plugins/notes/assets/${assetId}`, { token });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: NoteBody[] }).items;
  };

  /** Edit as `token` (the member by default; null for anonymous). */
  const edit = (id: number, body: Record<string, unknown>, token: string | null = member.token) =>
    live.request(`/plugins/notes/notes/${id}`, {
      method: "PATCH",
      token: token ?? undefined,
      body: JSON.stringify(body),
    });

  /** Delete as `token` (the member by default; null for anonymous). */
  const remove = (id: number, token: string | null = member.token) =>
    live.request(`/plugins/notes/notes/${id}`, { method: "DELETE", token: token ?? undefined });

  it("adds notes and lists them in reading order", async () => {
    const id = await live.post("a", admin.id);
    const created = await added(id, "  bottom\nline  ", { x: 0.5, y: 0.7, w: 0.2, h: 0.1 });
    expect(created).toMatchObject({ x: 0.5, y: 0.7, w: 0.2, h: 0.1, body: "bottom\nline", authorName: "member" });
    expect(created.canEdit).toBe(true);
    expect(created).not.toHaveProperty("authorId");
    await added(id, "top right", { x: 0.6, y: 0.1, w: 0.2, h: 0.1 });
    await added(id, "top left", { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, other.token);
    // Hanging off the image: clamped to it.
    const clamped = await added(id, "edge", { x: 0.9, y: 0.4, w: 0.5, h: 0.1 });
    expect(clamped).toMatchObject({ x: 0.9, w: 0.1 });

    const notes = await list(id);
    expect(notes.map((note) => note.body)).toEqual(["top left", "top right", "edge", "bottom\nline"]);
    // Anonymous: nothing editable. canEdit follows the caller.
    expect(notes.some((note) => note.canEdit)).toBe(false);
    expect((await list(id, member.token)).map((note) => note.canEdit)).toEqual([false, true, true, true]);
    expect((await list(id, admin.token)).every((note) => note.canEdit)).toBe(true);
    expect(await list(await live.post("empty", admin.id))).toEqual([]);
  });

  it("lets the author edit the text and box, then delete the note", async () => {
    const id = await live.post("b", admin.id);
    const created = await added(id, "draft");

    const res = await edit(created.id, { body: " final ", x: 0.3 });
    expect(res.status).toBe(200);
    const edited = (await res.json()) as NoteBody;
    expect(edited).toMatchObject({ id: created.id, body: "final", x: 0.3, y: 0.1, w: 0.2, h: 0.1 });
    expect(new Date(edited.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());

    const resized = (await (await edit(created.id, { w: 0.5, h: 0.5 })).json()) as NoteBody;
    expect(resized).toMatchObject({ body: "final", x: 0.3, y: 0.1, w: 0.5, h: 0.5 });
    expect((await list(id)).map((note) => note.body)).toEqual(["final"]);

    expect((await edit(created.id, {})).status).toBe(400);
    expect((await edit(created.id, { body: "  " })).status).toBe(400);
    // Completed from the stored box (x 0.3), a width of 0.9 is clamped to 0.7.
    expect(((await (await edit(created.id, { w: 0.9 })).json()) as NoteBody).w).toBe(0.7);

    expect((await remove(created.id)).status).toBe(204);
    expect(await list(id)).toEqual([]);
    expect((await remove(created.id)).status).toBe(404);
    expect((await edit(created.id, { body: "again" })).status).toBe(404);
  });

  it("refuses other members and anonymous callers, but lets an admin moderate", async () => {
    const id = await live.post("c", admin.id);
    const created = await added(id, "mine");

    expect((await add(id, { ...BOX, body: "hi" }, null)).status).toBe(401);
    expect((await edit(created.id, { body: "hijacked" }, null)).status).toBe(401);
    expect((await remove(created.id, null)).status).toBe(401);
    expect((await edit(created.id, { body: "hijacked" }, other.token)).status).toBe(403);
    expect((await remove(created.id, other.token)).status).toBe(403);

    const moderated = await edit(created.id, { body: "[removed]" }, admin.token);
    expect(moderated.status).toBe(200);
    expect(((await moderated.json()) as NoteBody).authorName).toBe("member");
    expect((await remove(created.id, admin.token)).status).toBe(204);
  });

  it("refuses bad geometry, bad text and unknown posts", async () => {
    const id = await live.post("d", admin.id);
    const tiny = await add(id, { x: 0.5, y: 0.5, w: 0.001, h: 0.1, body: "hi" });
    expect(tiny.status).toBe(400);
    expect(JSON.stringify(await tiny.json())).toContain("at least 0.5%");
    expect((await add(id, { x: 2, y: 0.5, w: 0.1, h: 0.1, body: "hi" })).status).toBe(400);
    expect((await add(id, { x: 0.5, y: 0.5, w: -0.1, h: 0.1, body: "hi" })).status).toBe(400);
    // Malformed input fails the route schema (Elysia's 422) before the geometry check.
    expect((await add(id, { x: "left", y: 0.5, w: 0.1, h: 0.1, body: "hi" })).status).toBe(422);
    expect((await add(id, { y: 0.5, w: 0.1, h: 0.1, body: "hi" })).status).toBe(422);
    expect((await add(id, { ...BOX, body: "   " })).status).toBe(400);
    expect((await add(id, { ...BOX, body: "a".repeat(1001) })).status).toBe(400);

    const created = await added(id, "ok");
    // Moved so far right that only a 0.001 sliver of the box stays on the image.
    expect((await edit(created.id, { x: 0.999 })).status).toBe(400);
    expect((await edit(created.id, { h: 0 })).status).toBe(400);

    expect((await add(99_999, { ...BOX, body: "hi" })).status).toBe(404);
    expect(await list(id)).toHaveLength(1);
  });

  it("caps a post at 100 notes", async () => {
    const id = await live.post("e", admin.id);
    await live.db.execute(sql`
      INSERT INTO notes_notes (asset_id, x, y, w, h, body, author_id, author_name)
      SELECT ${id}, 0.1, 0.1, 0.1, 0.1, 'note ' || g, ${member.id}, 'member' FROM generate_series(1, 99) AS g
    `);
    await added(id, "the hundredth");
    const full = await add(id, { ...BOX, body: "one too many" });
    expect(full.status).toBe(409);
    expect(JSON.stringify(await full.json())).toContain("at most 100 notes");
    expect(await list(id)).toHaveLength(100);
    // Another post is unaffected.
    await added(await live.post("f", admin.id), "elsewhere");
  });

  it("deletes a post's notes when the post is deleted", async () => {
    const id = await live.post("g", member.id);
    const kept = await live.post("h", member.id);
    await added(id, "one");
    await added(id, "two", BOX, other.token);
    await added(kept, "stays");

    expect(await live.core.assetService.delete(id, { deletedById: admin.id, reason: "" })).toBe(true);

    const remaining = async () => live.db.execute<{ asset_id: string }>(sql`SELECT asset_id FROM notes_notes`);
    await eventually(async () => (await remaining()).length === 1);
    const rows = await remaining();
    expect(rows.map((row) => Number(row.asset_id))).toEqual([kept]); // a raw bigint comes back as text
    expect(await list(id)).toEqual([]);
  });

  it("leaves no note behind on a post deleted while it was being added", async () => {
    const id = await live.post("racing", admin.id);
    // The post exists at the check, and is gone (its cleanup already run) by
    // the time the note is written.
    const service = live.core.assetService;
    const getById = service.getById;
    let calls = 0;
    service.getById = async (assetId) => (assetId === id && ++calls > 1 ? null : getById(assetId));
    let res: Response;
    try {
      res = await add(id, { ...BOX, body: "first!" });
    } finally {
      service.getById = getById;
    }
    expect(res.status).toBe(404);
    expect([...(await live.db.execute(sql`SELECT 1 FROM notes_notes WHERE asset_id = ${id}`))]).toEqual([]);
  });
});
