import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

/** A report, as the plugin's routes return it. */
interface ReportBody {
  id: number;
  assetId: number;
  reporterName: string | null;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  resolution: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
}

/** A page of the moderator queue. */
interface QueuePage {
  items: ReportBody[];
  nextBefore: number | null;
}

/**
 * The reports plugin end to end: its real migrations, routes and
 * `asset.deleted` listener. Against the opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("reports plugin (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let member: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive(["reports"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, reports_reports RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // the first account is the admin
    member = await live.user("member");
  });

  /** File a report as `token` (the member by default; null for anonymous). */
  const report = (assetId: number, body: Record<string, unknown>, token: string | null = member.token) =>
    live.request(`/plugins/reports/assets/${assetId}`, {
      method: "POST",
      token: token ?? undefined,
      body: JSON.stringify(body),
    });

  const queue = async (query = "", token = admin.token): Promise<QueuePage> => {
    const res = await live.request(`/plugins/reports/queue${query}`, { token });
    expect(res.status).toBe(200);
    return (await res.json()) as QueuePage;
  };

  const dismiss = (id: number, body: Record<string, unknown> = {}, token = admin.token) =>
    live.request(`/plugins/reports/reports/${id}/dismiss`, { method: "POST", token, body: JSON.stringify(body) });

  it("files a report, once per user while it's open", async () => {
    const id = await live.post("a", admin.id);
    const created = await report(id, { reason: "  spam  " });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      assetId: id,
      reporterName: "member",
      reason: "spam",
      status: "open",
      resolution: null,
    });

    expect((await report(id, { reason: "again" })).status).toBe(409);
    // Another user may report the same post.
    expect((await report(id, { reason: "also spam" }, admin.token)).status).toBe(201);

    const open = await live.request(`/plugins/reports/assets/${id}`, { token: admin.token });
    expect(((await open.json()) as { items: ReportBody[] }).items).toHaveLength(2);
  });

  it("refuses unknown posts, blank reasons and anonymous callers", async () => {
    const id = await live.post("b", admin.id);
    expect((await report(99_999, { reason: "spam" })).status).toBe(404);
    expect((await report(id, { reason: "   " })).status).toBe(400);
    expect((await report(id, { reason: "a".repeat(501) })).status).toBe(400);
    expect((await report(id, { reason: "spam" }, null)).status).toBe(401);
  });

  it("serves the queue to moderators only, newest first, in pages of 50", async () => {
    expect((await live.request("/plugins/reports/queue")).status).toBe(401);
    expect((await live.request("/plugins/reports/queue", { token: member.token })).status).toBe(403);
    expect((await live.request("/plugins/reports/assets/1", { token: member.token })).status).toBe(403);

    // 51 open reports (the queue doesn't need the posts to exist) and one dismissed.
    await live.db.execute(sql`
      INSERT INTO reports_reports (asset_id, reporter_id, reporter_name, reason)
      SELECT g, ${member.id}, 'member', 'reason ' || g FROM generate_series(1, 51) AS g
    `);
    await live.db.execute(sql`
      INSERT INTO reports_reports (asset_id, reporter_id, reporter_name, reason, status)
      VALUES (52, ${member.id}, 'member', 'old', 'dismissed')
    `);

    const first = await queue();
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.id).toBe(51);
    expect(first.items.every((item) => item.status === "open")).toBe(true);
    expect(first.nextBefore).toBe(2);

    const second = await queue(`?before=${first.nextBefore}`);
    expect(second.items.map((item) => item.id)).toEqual([1]);
    expect(second.nextBefore).toBeNull();

    const dismissed = await queue("?status=dismissed");
    expect(dismissed.items.map((item) => item.reason)).toEqual(["old"]);
  });

  it("dismisses an open report, once", async () => {
    const id = await live.post("c", admin.id);
    const created = (await (await report(id, { reason: "spam" })).json()) as ReportBody;

    expect((await dismiss(created.id, {}, member.token)).status).toBe(403);
    const done = await dismiss(created.id, { note: " not spam " });
    expect(done.status).toBe(200);
    const body = (await done.json()) as ReportBody;
    expect(body).toMatchObject({ status: "dismissed", resolution: "not spam", resolvedByName: "admin" });
    expect(body.resolvedAt).not.toBeNull();

    expect((await dismiss(created.id)).status).toBe(409);
    expect((await dismiss(99_999)).status).toBe(404);
    expect((await queue()).items).toHaveLength(0);

    // Once it's handled, the user may report the post again.
    expect((await report(id, { reason: "spam, really" })).status).toBe(201);
  });

  it("resolves a deleted post's open reports from the asset.deleted event", async () => {
    const id = await live.post("d", admin.id);
    const other = await live.post("e", admin.id);
    const handled = (await (await report(id, { reason: "spam" })).json()) as ReportBody;
    await dismiss(handled.id);
    await report(id, { reason: "spam again" });
    await report(id, { reason: "me too" }, admin.token);
    await report(other, { reason: "unrelated" });

    live.core.events.emit("asset.deleted", {
      id,
      sha256: "0".repeat(64),
      md5: "0".repeat(32),
      deletedById: admin.id,
      reason: "spam",
      deletedAt: new Date(),
    });

    // The listener runs fire-and-forget; poll briefly for its update.
    let resolved: QueuePage = { items: [], nextBefore: null };
    for (let i = 0; i < 50 && resolved.items.length < 2; i++) {
      resolved = await queue("?status=resolved");
      if (resolved.items.length < 2) await Bun.sleep(20);
    }
    expect(resolved.items).toHaveLength(2);
    for (const item of resolved.items) {
      expect(item).toMatchObject({ assetId: id, resolution: "Post deleted", resolvedByName: null });
      expect(item.resolvedAt).not.toBeNull();
    }
    // The dismissed report stays dismissed; the other post's report stays open.
    expect((await queue("?status=dismissed")).items.map((item) => item.id)).toEqual([handled.id]);
    expect((await queue()).items.map((item) => item.assetId)).toEqual([other]);
  });

  it("lets only moderators delete a reported post", async () => {
    const id = await live.post("f", admin.id);
    const remove = (token?: string) =>
      live.request(`/plugins/reports/assets/${id}/delete`, { method: "POST", token, body: JSON.stringify({}) });
    expect((await remove()).status).toBe(401);
    expect((await remove(member.token)).status).toBe(403);
  });
});
