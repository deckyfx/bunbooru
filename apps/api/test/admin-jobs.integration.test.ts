import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { bootLive, TEST_DATABASE_URL, type LiveApi } from "./plugins/live-harness";

/** The admin Jobs routes over the real queue. Against the opt-in test database (it TRUNCATEs). */
describe.skipIf(!TEST_DATABASE_URL)("admin jobs routes (integration)", () => {
  let live: LiveApi;
  let admin: { id: number; token: string };
  let member: { id: number; token: string };

  beforeAll(async () => {
    live = await bootLive([]);
  });
  afterAll(async () => {
    await live.close();
  });

  beforeEach(async () => {
    await live.db.execute(sql`TRUNCATE TABLE users, sessions, jobs RESTART IDENTITY CASCADE`);
    admin = await live.user("admin"); // the first account is the admin
    member = await live.user("member");
  });

  /** Queue a job and run it out of attempts. */
  async function failedJob(kind: string): Promise<number> {
    const repo = live.core.jobService.repository;
    await repo.enqueue({ kind, payload: {}, runAt: new Date(), maxAttempts: 1, idempotencyKey: `${kind}#1` });
    const [claimed] = await repo.claim({ kinds: [kind], limit: 1, leaseMs: 60_000, now: new Date() });
    await repo.fail(claimed!, "boom", null, new Date());
    return claimed!.id;
  }

  it("is admin-only", async () => {
    expect((await live.request("/admin/jobs")).status).toBe(401);
    expect((await live.request("/admin/jobs", { token: member.token })).status).toBe(403);
    expect((await live.request("/admin/jobs/1/retry", { method: "POST", token: member.token })).status).toBe(403);
  });

  it("refuses a retry while the same work is queued again", async () => {
    const failed = await failedJob("test:broken");
    await live.core.jobService.enqueue("test:broken", {}, { idempotencyKey: "test:broken#1" });
    const retry = await live.request(`/admin/jobs/${failed}/retry`, { method: "POST", token: admin.token });
    expect(retry.status).toBe(409);
  });

  it("reports counts and failures, and retries a failed job", async () => {
    await live.core.jobService.enqueue("test:waiting", { n: 1 });
    const failed = await failedJob("test:broken");

    const overview = await live.request("/admin/jobs", { token: admin.token });
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      counts: { kind: string; status: string; count: number }[];
      failures: { id: number; kind: string; lastError: string | null; finishedAt: string | null }[];
      runner: string;
      retentionDays: { done: number; failed: number };
    };
    expect(body.retentionDays).toEqual({ done: 7, failed: 30 });
    expect(body.counts).toContainEqual({ kind: "test:waiting", status: "queued", count: 1 });
    expect(body.counts).toContainEqual({ kind: "test:broken", status: "failed", count: 1 });
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ id: failed, kind: "test:broken", lastError: "boom" });
    expect(typeof body.failures[0]?.finishedAt).toBe("string");

    const retry = await live.request(`/admin/jobs/${failed}/retry`, { method: "POST", token: admin.token });
    expect(retry.status).toBe(204);
    expect(await live.core.jobService.counts()).toContainEqual({ kind: "test:broken", status: "queued", count: 1 });

    // Not failed any more (and an unknown id): nothing to retry.
    expect((await live.request(`/admin/jobs/${failed}/retry`, { method: "POST", token: admin.token })).status).toBe(404);
    expect((await live.request("/admin/jobs/99999/retry", { method: "POST", token: admin.token })).status).toBe(404);
  });
});
