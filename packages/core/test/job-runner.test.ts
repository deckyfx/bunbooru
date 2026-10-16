import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createDb, createJobRepository, type DB, type JsonValue } from "@bunbooru/db";

import { createJobRunner, retryDelayMs, type JobLogger } from "../src/jobs/job-runner";
import { createJobService, JobKindConflictError, type JobService } from "../src/jobs/job-service";

const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

const quiet: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("retryDelayMs", () => {
  it("doubles from 30s and caps at an hour", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(50)).toBe(60 * 60 * 1000);
  });
});

describe("JobService handler registry", () => {
  const service = () =>
    createJobService({} as Parameters<typeof createJobService>[0]);
  const handler = { run: async () => {} };

  it("registers per owner, replaces on re-register, and unregisters", () => {
    const jobs = service();
    jobs.register("thumbnailer", { "thumbnailer:thumbnail": handler, "thumbnailer:other": handler });
    jobs.register("thumbnailer", { "thumbnailer:thumbnail": handler });
    expect(jobs.kinds()).toEqual(["thumbnailer:thumbnail"]);
    jobs.unregister("thumbnailer");
    expect(jobs.kinds()).toEqual([]);
  });

  it("refuses a kind another owner handles, or a malformed kind, changing nothing", () => {
    const jobs = service();
    jobs.register("a", { "a:x": handler });
    expect(() => jobs.register("b", { "a:x": handler })).toThrow(JobKindConflictError);
    expect(() => jobs.register("b", { "no-colon": handler })).toThrow(JobKindConflictError);
    expect(() => jobs.register("b", { "b:ok": handler, "B:Bad": handler })).toThrow(JobKindConflictError);
    expect(jobs.kinds()).toEqual(["a:x"]);
  });

  it("refuses non-positive limits, changing nothing", () => {
    const jobs = service();
    for (const bad of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Number.NaN }, { timeoutMs: 24 * 60 * 60 * 1000 + 1 }, { maxAttempts: 0 }, { maxAttempts: 1.5 }, { maxAttempts: 2_147_483_648 }]) {
      expect(() => jobs.register("a", { "a:ok": handler, "a:bad": { ...handler, ...bad } })).toThrow(RangeError);
    }
    expect(jobs.kinds()).toEqual([]);
    jobs.register("a", {
      "a:ok": { ...handler, timeoutMs: 1, maxAttempts: 1 },
      "a:max": { ...handler, timeoutMs: 24 * 60 * 60 * 1000, maxAttempts: 2_147_483_647 },
    });
    expect(jobs.kinds()).toEqual(["a:ok", "a:max"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("job runner (integration)", () => {
  let db: DB;
  let jobs: JobService;
  let clock: Date;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE jobs RESTART IDENTITY`);
    clock = new Date(Date.UTC(2026, 0, 1));
    jobs = createJobService(createJobRepository(db), () => clock);
  });

  const runner = (concurrency = 2) => createJobRunner(jobs, quiet, { concurrency, now: () => clock });
  const statusOf = async (id: number) => {
    const [row] = await db.execute<{ status: string; attempts: number; last_error: string | null }>(
      sql`SELECT status, attempts, last_error FROM jobs WHERE id = ${id}`,
    );
    return row;
  };

  it("runs a queued job through its handler and marks it done", async () => {
    const seen: JsonValue[] = [];
    jobs.register("core", { "core:echo": { run: async (payload) => void seen.push(payload) } });
    const { id } = await jobs.enqueue("core:echo", { hello: "world" });
    await runner().tick();
    expect(seen).toEqual([{ hello: "world" }]);
    expect(await statusOf(id)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("retries a throwing handler after the backoff, then fails it for good", async () => {
    let calls = 0;
    jobs.register("core", {
      "core:flaky": {
        maxAttempts: 2,
        run: async () => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
      },
    });
    const { id } = await jobs.enqueue("core:flaky", null);
    const r = runner();
    await r.tick();
    expect(await statusOf(id)).toMatchObject({ status: "queued", attempts: 1, last_error: "boom 1" });

    await r.tick(); // still backing off
    expect(calls).toBe(1);

    clock = new Date(clock.getTime() + retryDelayMs(1));
    await r.tick();
    expect(await statusOf(id)).toMatchObject({ status: "failed", attempts: 2, last_error: "boom 2" });
    expect((await jobs.recentFailures())[0]).toMatchObject({ id, kind: "core:flaky" });
  });

  it("leaves jobs of a kind with no handler waiting, and runs them once one appears", async () => {
    const { id } = await jobs.enqueue("pools:rebuild", 1);
    await runner().tick();
    expect(await statusOf(id)).toMatchObject({ status: "queued", attempts: 0 });

    jobs.register("pools", { "pools:rebuild": { run: async () => {} } });
    await runner().tick();
    expect(await statusOf(id)).toMatchObject({ status: "done" });
  });

  it("never runs more than `concurrency` jobs at once", async () => {
    let running = 0;
    let peak = 0;
    jobs.register("core", {
      "core:slow": {
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await Bun.sleep(20);
          running -= 1;
        },
      },
    });
    for (let i = 0; i < 6; i++) await jobs.enqueue("core:slow", i);
    const r = runner(2);
    for (let i = 0; i < 6; i++) await r.tick();
    await Bun.sleep(100);
    expect(peak).toBe(2);
    const [done] = await db.execute<{ n: number | string }>(sql`SELECT count(*) AS n FROM jobs WHERE status = 'done'`);
    expect(Number(done?.n)).toBe(6);
  });

  it("dedupes an idempotent enqueue while the first is pending", async () => {
    const first = await jobs.enqueue("core:echo", 1, { idempotencyKey: "same" });
    const second = await jobs.enqueue("core:echo", 1, { idempotencyKey: "same" });
    expect(second).toEqual({ id: first.id, created: false });
  });

  it("wakes on enqueue and drains in-flight work on stop", async () => {
    let finished = false;
    jobs.register("core", {
      "core:wait": {
        run: async () => {
          await Bun.sleep(50);
          finished = true;
        },
      },
    });
    const r = createJobRunner(jobs, quiet, { pollMs: 60_000, now: () => clock });
    r.start();
    await jobs.enqueue("core:wait", null); // no poll for a minute: the enqueue wakes it
    await Bun.sleep(20);
    await r.stop(1_000);
    expect(finished).toBe(true);
  });

  it("doesn't count a failure to record success as a failed run", async () => {
    const repository = createJobRepository(db);
    let completeCalls = 0;
    jobs = createJobService(
      {
        ...repository,
        complete: async (job, now) => {
          completeCalls += 1;
          if (completeCalls === 1) throw new Error("connection reset");
          return repository.complete(job, now);
        },
      },
      () => clock,
    );
    let runs = 0;
    jobs.register("core", { "core:once": { maxAttempts: 1, run: async () => void runs++ } });
    const { id } = await jobs.enqueue("core:once", null);

    await runner().tick();
    // Not failed (it was its only attempt): still leased, to be re-run once the lease lapses.
    expect(await statusOf(id)).toMatchObject({ status: "running", last_error: null });
    expect(runs).toBe(1);
  });

  it("waits for a claim in flight on stop, so the jobs it took still run", async () => {
    const repository = createJobRepository(db);
    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve));
    jobs = createJobService(
      {
        ...repository,
        claim: async (input) => {
          const claimed = await repository.claim(input);
          await claimGate; // the database answered; the runner hasn't seen it yet
          return claimed;
        },
      },
      () => clock,
    );
    const ran: number[] = [];
    jobs.register("core", { "core:slow": { run: async () => void ran.push(1) } });
    const { id } = await jobs.enqueue("core:slow", null);

    const r = runner();
    const pass = r.tick(); // a claim now in flight
    await Bun.sleep(20);
    const stopped = r.stop(5_000);
    releaseClaim();
    await stopped;
    // By the time stop() resolves (and a shutdown would exit), the job is done.
    expect(ran).toEqual([1]);
    expect(await statusOf(id)).toMatchObject({ status: "done" });
    await pass;
  });

  it("refuses to enqueue a malformed kind", async () => {
    await expect(jobs.enqueue("nocolon", 1)).rejects.toBeInstanceOf(JobKindConflictError);
  });
});
