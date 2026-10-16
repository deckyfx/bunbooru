import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createJobRunner, type JobRunner } from "@bunbooru/core";

import { bootLive, TEST_DATABASE_URL, type LiveApi } from "./live-harness";

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
