import type { ClaimedJob } from "@bunbooru/db";

import { DEFAULT_TIMEOUT_MS, type JobService } from "./job-service";

/** Structured logging the runner reports through. */
export interface JobLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface JobRunnerOptions {
  /** Jobs run at once (default 2). */
  concurrency?: number;
  /** Idle poll interval (default 2s); an enqueue in this process wakes it at once. */
  pollMs?: number;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface JobRunner {
  start(): void;
  /** Stop claiming new work and wait for in-flight jobs (up to `graceMs`). */
  stop(graceMs?: number): Promise<void>;
  /** Claim and run one batch now; resolves when those jobs finish. For tests. */
  tick(): Promise<void>;
}

/** Retry delay after the `attempt`-th failure: 30s, 1m, 2m, … capped at 1h. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);
}

/**
 * The loop that executes queued jobs: claim due work for the kinds that have a
 * handler, run each (at most `concurrency` at once), and record the outcome.
 * Safe to run in several processes against one database: claims never overlap.
 * Runs inside the API by default, or alone in a dedicated worker process.
 */
export function createJobRunner(
  jobs: JobService,
  log: JobLogger,
  { concurrency = 2, pollMs = 2000, now = () => new Date() }: JobRunnerOptions = {},
): JobRunner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let claiming: Promise<Promise<void>[]> | null = null;
  let rerun = false;
  const active = new Set<Promise<void>>();

  /** A lost lease: the job overran and another runner took it, so this outcome is dropped. */
  function leaseLost(job: ClaimedJob): void {
    log.warn("job_lease_lost", { id: job.id, kind: job.kind, attempt: job.attempts });
  }

  async function execute(job: ClaimedJob): Promise<void> {
    const handler = jobs.handler(job.kind);
    if (!handler) {
      // Unregistered between claim and run (its plugin was deactivated): hand it
      // back untouched so it runs once the handler returns.
      if (!(await jobs.repository.release(job, now()))) leaseLost(job);
      return;
    }
    const started = performance.now();
    try {
      await handler.run(job.payload, { id: job.id, attempt: job.attempts, maxAttempts: job.maxAttempts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalAttempt = job.attempts >= job.maxAttempts;
      const retryAt = finalAttempt ? null : new Date(now().getTime() + retryDelayMs(job.attempts));
      if (!(await jobs.repository.fail(job, message, retryAt, now()))) return leaseLost(job);
      const fields = { id: job.id, kind: job.kind, attempt: job.attempts, maxAttempts: job.maxAttempts, error: message };
      if (retryAt) log.warn("job_retry", { ...fields, retryAt: retryAt.toISOString() });
      else log.error("job_failed", fields);
      return;
    }
    // Outside the try: a failure to RECORD success isn't the handler failing.
    // It propagates to `job_record_failed`, and the lapsed lease re-runs the job.
    if (!(await jobs.repository.complete(job, now()))) return leaseLost(job);
    log.info("job_done", { id: job.id, kind: job.kind, attempt: job.attempts, ms: Math.round(performance.now() - started) });
  }

  /**
   * Claim due work for the free slots and START it. Returns the started runs
   * without waiting for them: a slow job must not hold back claiming more
   * while other slots are free.
   */
  async function claimAndStart(): Promise<Promise<void>[]> {
    await jobs.repository.failAbandoned(now());
    const kinds = jobs.kinds();
    const slots = concurrency - active.size;
    if (kinds.length === 0 || slots <= 0) return [];
    // One lease for the batch, long enough for the slowest kind being claimed.
    const leaseMs = Math.max(...kinds.map((kind) => jobs.handler(kind)?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const claimed = await jobs.repository.claim({ kinds, limit: slots, leaseMs, now: now() });
    return claimed.map((job) => {
      const run = execute(job)
        .catch((error: unknown) => {
          // Recording the outcome itself failed (database down): the lease will
          // lapse and the job runs again, which handlers are built to tolerate.
          log.error("job_record_failed", { id: job.id, kind: job.kind, error: String(error) });
        })
        .finally(() => {
          active.delete(run);
          // A slot freed up: there may be more due work.
          if (!stopping) void poll();
        });
      active.add(run);
      return run;
    });
  }

  /**
   * One claim pass at a time; a poll requested mid-claim runs once more after
   * it. Resolves once the claim is done and its jobs have started.
   */
  function poll(): Promise<Promise<void>[]> {
    if (stopping) return Promise.resolve([]);
    if (claiming) {
      rerun = true;
      return claiming;
    }
    claiming = claimAndStart()
      .catch((error: unknown) => {
        log.error("job_runner_pass_failed", { error: error instanceof Error ? error.message : String(error) });
        return [];
      })
      .finally(() => {
        claiming = null;
        if (rerun && !stopping) {
          rerun = false;
          void poll();
        }
      });
    return claiming;
  }

  jobs.onEnqueue(() => {
    if (timer !== undefined) void poll();
  });

  return {
    start() {
      if (timer !== undefined) return;
      stopping = false;
      timer = setInterval(() => void poll(), pollMs);
      timer.unref();
      void poll();
      log.info("job_runner_started", { concurrency, pollMs });
    },

    async stop(graceMs = 30_000) {
      stopping = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      // A claim already sent to the database still starts its jobs (they're
      // leased, their attempt counted): let them join `active` before draining.
      if (claiming) await claiming;
      if (active.size === 0) return;
      const drained = Promise.all([...active]).then(() => undefined);
      await Promise.race([drained, Bun.sleep(graceMs)]);
      if (active.size > 0) log.warn("job_runner_stopped_with_work", { inFlight: active.size });
    },

    async tick() {
      await Promise.all(await poll());
    },
  };
}
