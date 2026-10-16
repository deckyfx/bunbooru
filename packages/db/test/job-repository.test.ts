import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createDb, createJobRepository, textArray, type DB, type JobRepository } from "../src/index";

/**
 * Integration tests for the durable job queue against a real Postgres (opt-in
 * via TEST_DATABASE_URL; see asset-repository.test). What only SQL can prove:
 * the claim's locking, leases, the partial idempotency index, and backoff.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe.skipIf(!TEST_DATABASE_URL)("JobRepository (integration)", () => {
  let db: DB;
  let jobs: JobRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    jobs = createJobRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE jobs RESTART IDENTITY`);
  });

  const claimAt = (seconds: number, kinds = ["k:a"], limit = 10) =>
    jobs.claim({ kinds, limit, leaseMs: 60_000, now: at(seconds) });

  it("queues, claims due work of the given kinds, and completes it", async () => {
    await jobs.enqueue({ kind: "k:a", payload: { n: 1 }, runAt: at(0) });
    await jobs.enqueue({ kind: "k:b", payload: { n: 2 }, runAt: at(0) });
    await jobs.enqueue({ kind: "k:a", payload: { n: 3 }, runAt: at(100) }); // not due yet

    const claimed = await claimAt(10);
    expect(claimed.map((j) => j.payload)).toEqual([{ n: 1 }]);
    expect(claimed[0]).toMatchObject({ status: "running", attempts: 1 });
    expect(await claimAt(10)).toEqual([]); // already leased

    await jobs.complete(claimed[0]!, at(11));
    const counts = await jobs.counts();
    expect(counts).toContainEqual({ kind: "k:a", status: "done", count: 1 });
    expect(counts).toContainEqual({ kind: "k:a", status: "queued", count: 1 });
  });

  it("dedupes by idempotency key only while pending", async () => {
    const first = await jobs.enqueue({ kind: "k:a", payload: 1, idempotencyKey: "thumb:7", runAt: at(0) });
    const again = await jobs.enqueue({ kind: "k:a", payload: 1, idempotencyKey: "thumb:7" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });

    const [claimed] = await claimAt(1);
    await jobs.complete(claimed!, at(2));
    const later = await jobs.enqueue({ kind: "k:a", payload: 1, idempotencyKey: "thumb:7" });
    expect(later.created).toBe(true); // done, so the same work may run again
    expect(later.id).not.toBe(first.id);
  });

  it("never hands one job to two concurrent claimers", async () => {
    for (let i = 0; i < 20; i++) await jobs.enqueue({ kind: "k:a", payload: i, runAt: at(0) });
    const [a, b] = await Promise.all([claimAt(1, ["k:a"], 15), claimAt(1, ["k:a"], 15)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("reclaims a job whose lease lapsed, counting the attempt", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, runAt: at(0) });
    await claimAt(0); // runner leases it for 60s, then "crashes"
    expect(await claimAt(30)).toEqual([]);
    const [reclaimed] = await claimAt(61);
    expect(reclaimed).toMatchObject({ status: "running", attempts: 2 });
  });

  it("retries a failure at the given time, then fails it for good", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, runAt: at(0), maxAttempts: 2 });
    const [first] = await claimAt(0);
    await jobs.fail(first!, "boom", at(30), at(1));
    expect(await claimAt(10)).toEqual([]); // backing off
    const [second] = await claimAt(30);
    expect(second).toMatchObject({ attempts: 2, lastError: "boom" });
    await jobs.fail(second!, "boom again", null, at(31));

    const [failure] = await jobs.recentFailures(10);
    expect(failure).toMatchObject({ status: "failed", lastError: "boom again", attempts: 2 });
    expect(await claimAt(1000)).toEqual([]);
  });

  it("fails a job abandoned on its final attempt instead of retrying it forever", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, runAt: at(0), maxAttempts: 1 });
    await claimAt(0); // the only attempt; the runner never reports back
    expect(await claimAt(120)).toEqual([]); // no attempts left to reclaim
    expect(await jobs.failAbandoned(at(120))).toBe(1);
    expect((await jobs.recentFailures(1))[0]?.lastError).toMatch(/Abandoned/);
  });

  it("releases a claimed job without spending its attempt", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, runAt: at(0) });
    const [claimed] = await claimAt(0);
    await jobs.release(claimed!, at(1));
    const [again] = await claimAt(2);
    expect(again?.attempts).toBe(1);
  });

  it("retries a failed job with fresh attempts, and prunes old finished jobs", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, runAt: at(0), maxAttempts: 1 });
    const [claimed] = await claimAt(0);
    await jobs.fail(claimed!, "boom", null, at(1));
    expect(await jobs.retry(claimed!.id, at(2))).toBe("retried");
    expect(await jobs.retry(claimed!.id, at(2))).toBe("not-failed"); // no longer failed
    const [rerun] = await claimAt(3);
    expect(rerun?.attempts).toBe(1);
    await jobs.complete(rerun!, at(4));

    expect(await jobs.prune({ doneBefore: at(4), failedBefore: at(4) })).toBe(0);
    expect(await jobs.prune({ doneBefore: at(5), failedBefore: at(5) })).toBe(1);
  });

  it("drops the outcome of a runner whose lease was taken over", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, runAt: at(0) });
    const [stale] = await claimAt(0); // overruns its 60s lease…
    const [current] = await claimAt(61); // …so another runner takes the job
    // The first runner's late outcomes match nothing: no double completion, and
    // above all no re-queue of a job that is running elsewhere.
    expect(await jobs.fail(stale!, "late", at(100), at(62))).toBe(false);
    expect(await jobs.complete(stale!, at(62))).toBe(false);
    expect(await jobs.release(stale!, at(62))).toBe(false);
    expect(await claimAt(63)).toEqual([]);

    expect(await jobs.complete(current!, at(64))).toBe(true);
    expect(await jobs.counts()).toEqual([{ kind: "k:a", status: "done", count: 1 }]);
  });

  it("refuses to retry a failed job whose key is pending again", async () => {
    await jobs.enqueue({ kind: "k:a", payload: 1, idempotencyKey: "thumb:7", runAt: at(0), maxAttempts: 1 });
    const [claimed] = await claimAt(0);
    await jobs.fail(claimed!, "boom", null, at(1));
    await jobs.enqueue({ kind: "k:a", payload: 1, idempotencyKey: "thumb:7", runAt: at(2) }); // queued again

    expect(await jobs.retry(claimed!.id, at(3))).toBe("already-queued");
    expect((await jobs.recentFailures(1))[0]?.id).toBe(claimed!.id); // left failed
  });

  it("binds a text[] parameter, escaping quotes, commas and backslashes", async () => {
    const tricky = ['a"b', "c,d", "e\\f", "{g}"];
    const rows = await db.execute<{ v: string }>(sql`SELECT unnest(${textArray(tricky)}) AS v`);
    expect([...rows].map((r) => r.v)).toEqual(tricky);
  });
});
