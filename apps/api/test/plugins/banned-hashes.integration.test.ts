import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { IngestRejectedError } from "@bunbooru/core";

import { bootLive, TEST_DATABASE_URL, uniqueImage, type LiveApi } from "./live-harness";

/**
 * The banned-hashes plugin end to end: its real migrations and routes, and its
 * ingest guard running inside Core's upload pipeline. Against the opt-in test
 * database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("banned-hashes plugin (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let member: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive(["banned-hashes"]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(
      sql`TRUNCATE TABLE assets, asset_tags, tags, users, sessions, banned_hashes_entries RESTART IDENTITY CASCADE`,
    );
    admin = await live.user("admin"); // the first account is the admin
    member = await live.user("member");
  });

  const ban = (body: Record<string, unknown>, token = admin.token) =>
    live.request("/plugins/banned-hashes/bans", { method: "POST", token, body: JSON.stringify(body) });

  /** Upload `bytes` through the real HTTP route. */
  const upload = (bytes: Uint8Array, token = member.token) => {
    const form = new FormData();
    form.append("file", new File([bytes], "a.png", { type: "image/png" }));
    return live.request("/assets", { method: "POST", token, body: form });
  };

  it("refuses a banned file on upload, even though a copy is already stored", async () => {
    const id = await live.post("a", admin.id);
    const created = await ban({ assetId: id, reason: "spam" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ reason: "spam", bannedByName: "admin" });

    // Without the guard this would be a dedupe hit (200) on the stored copy.
    const again = await upload(uniqueImage("a"));
    expect(again.status).toBe(403);
    expect(JSON.stringify(await again.json())).toContain("This file is banned: spam");

    // Other files are unaffected.
    expect((await upload(uniqueImage("b"))).status).toBe(201);
  });

  it("matches on md5 alone (imported booru ban lists), from any ingest source", async () => {
    const bytes = uniqueImage("c");
    const md5 = new Bun.CryptoHasher("md5").update(bytes).digest("hex");
    expect((await ban({ md5 })).status).toBe(201);
    // The service path (importers, resumable finalize) is guarded too.
    await expect(live.core.assetService.create({ bytes, uploaderId: member.id })).rejects.toBeInstanceOf(
      IngestRejectedError,
    );
  });

  it("lifts a ban", async () => {
    const id = await live.post("d", admin.id);
    const created = (await (await ban({ assetId: id })).json()) as { id: number };
    expect((await upload(uniqueImage("d"))).status).toBe(403);

    const lifted = await live.request(`/plugins/banned-hashes/bans/${created.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    expect(lifted.status).toBe(204);
    expect((await upload(uniqueImage("d"))).status).toBe(200); // a dedupe hit again
  });

  it("lists bans, reports a post's ban, and refuses duplicates and bad input", async () => {
    const id = await live.post("e", admin.id);
    expect(
      await (await live.request(`/plugins/banned-hashes/assets/${id}`, { token: admin.token })).json(),
    ).toEqual({ ban: null });
    await ban({ assetId: id });
    expect((await ban({ assetId: id })).status).toBe(409);
    expect((await ban({ sha256: "nothex" })).status).toBe(400);
    expect((await ban({})).status).toBe(400);
    expect((await ban({ assetId: id, md5: "a".repeat(32) })).status).toBe(400);
    expect((await ban({ assetId: 99_999 })).status).toBe(404);

    const status = (await (await live.request(`/plugins/banned-hashes/assets/${id}`, { token: admin.token })).json()) as {
      ban: { id: number } | null;
    };
    expect(status.ban).not.toBeNull();
    const list = (await (await live.request("/plugins/banned-hashes/bans", { token: admin.token })).json()) as {
      items: unknown[];
      nextBefore: number | null;
    };
    expect(list.items).toHaveLength(1);
    expect(list.nextBefore).toBeNull();
  });

  it("is moderators only", async () => {
    expect((await live.request("/plugins/banned-hashes/bans")).status).toBe(401);
    expect((await live.request("/plugins/banned-hashes/bans", { token: member.token })).status).toBe(403);
    expect((await ban({ md5: "a".repeat(32) }, member.token)).status).toBe(403);
  });
});
