import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createJobRunner, type JobRunner } from "@bunbooru/core";
import { thumbnailKey } from "@bunbooru/plugin-thumbnailer";

import { bootLive, eventually, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The thumbnailer end to end on the job queue: an upload queues a durable
 * `thumbnail` job, a runner executes it, and the route serves the result; the
 * admin backfill queues a chain of jobs for assets that have none. Against the
 * opt-in test database (it TRUNCATEs).
 */
describe.skipIf(!TEST_DATABASE_URL)("thumbnailer plugin on the job queue (integration)", () => {
  let live: LiveApi;
  let runner: JobRunner;
  let admin: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive(["thumbnailer"]);
    runner = createJobRunner(live.core.jobService, quiet);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(sql`TRUNCATE TABLE assets, users, sessions, jobs, thumbnails RESTART IDENTITY CASCADE`);
    admin = await live.user("admin");
  });

  /** Pending jobs of `kind`, straight from the queue. */
  const pending = async (kind: string): Promise<number> => {
    const counts = await live.core.jobService.counts();
    return counts
      .filter((c) => c.kind === kind && (c.status === "queued" || c.status === "running"))
      .reduce((sum, c) => sum + c.count, 0);
  };

  /** The `asset.created` listener enqueues asynchronously: wait for it to land. */
  const queuedSoon = async (kind: string, count: number): Promise<void> => {
    for (let i = 0; i < 100 && (await pending(kind)) < count; i++) await Bun.sleep(10);
    expect(await pending(kind)).toBe(count);
  };

  /** Run jobs until the queue has nothing due left. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await runner.tick();
      if ((await pending("thumbnailer:thumbnail")) + (await pending("thumbnailer:backfill")) === 0) return;
    }
    throw new Error("the queue never drained");
  };

  const thumb = (id: number) => live.request(`/plugins/thumbnailer/asset/${id}/thumb`);

  it("thumbnails an upload through a queued job", async () => {
    const id = await live.post("a", admin.id);
    await queuedSoon("thumbnailer:thumbnail", 1);
    expect((await thumb(id)).status).toBe(404);

    await drain();
    const res = await thumb(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  it("drops a deleted post's thumbnail row and stored file", async () => {
    const id = await live.post("doomed", admin.id);
    await queuedSoon("thumbnailer:thumbnail", 1);
    await drain();
    expect((await thumb(id)).status).toBe(200);
    const storedKey = async () =>
      [...(await live.db.execute<{ storage_key: string | null }>(
        sql`SELECT storage_key FROM thumbnails WHERE asset_id = ${id}`,
      ))][0]?.storage_key;
    const key = await storedKey();
    expect(key).toBeString();
    expect(await live.storage.exists(`plugins/thumbnailer/${key}`)).toBe(true);

    expect(await live.core.assetService.delete(id, { deletedById: admin.id, reason: "" })).toBe(true);
    await eventually(async () => (await storedKey()) === undefined);

    expect(await storedKey()).toBeUndefined();
    expect(await live.storage.exists(`plugins/thumbnailer/${key}`)).toBe(false);
    expect((await thumb(id)).status).toBe(404);
  });

  it("records nothing for a post deleted while its thumbnail job waited", async () => {
    const id = await live.post("gone", admin.id);
    await queuedSoon("thumbnailer:thumbnail", 1);
    expect(await live.core.assetService.delete(id, { deletedById: admin.id, reason: "" })).toBe(true);

    await drain();
    const rows = await live.db.execute(sql`SELECT 1 FROM thumbnails WHERE asset_id = ${id}`);
    expect([...rows]).toEqual([]);
  });

  it("undoes its work for a post deleted while the thumbnail was being made", async () => {
    const id = await live.post("mid", admin.id);
    await queuedSoon("thumbnailer:thumbnail", 1);
    // The post exists when the job starts, and is gone (its cleanup already
    // run, finding nothing) by the time the thumbnail is written.
    const service = live.core.assetService;
    const getById = service.getById;
    let calls = 0;
    service.getById = async (assetId) => (assetId === id && ++calls > 1 ? null : getById(assetId));
    try {
      await drain();
    } finally {
      service.getById = getById;
    }

    expect(calls).toBe(2);
    expect([...(await live.db.execute(sql`SELECT 1 FROM thumbnails WHERE asset_id = ${id}`))]).toEqual([]);
    expect(await live.storage.exists(`plugins/thumbnailer/${thumbnailKey(id)}`)).toBe(false);
  });

  it("backfills assets that have no thumbnail, and reports the backfill already starting", async () => {
    const ids = [await live.post("a", admin.id), await live.post("b", admin.id)];
    await queuedSoon("thumbnailer:thumbnail", 2);
    // As if the uploads predated the plugin: no jobs, no thumbnails.
    await live.db.execute(sql`TRUNCATE TABLE jobs`);

    const backfill = () => live.request("/plugins/thumbnailer/backfill", { method: "POST", token: admin.token });
    expect(await (await backfill()).json()).toEqual({ queued: true });
    expect(await (await backfill()).json()).toEqual({ queued: false });

    await drain();
    for (const id of ids) expect((await thumb(id)).status).toBe(200);

    const status = await live.request("/plugins/thumbnailer/status", { token: admin.token });
    expect(await status.json()).toEqual({ totalAssets: 2, withThumbnails: 2, failed: 0, missing: 0 });
  });
});
