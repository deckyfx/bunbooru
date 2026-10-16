import { and, asc, count, desc, eq, lt, sql } from "drizzle-orm";

import type { DB } from "../client";
import { isUniqueViolation } from "../pg-errors";
import { jobs, type Job, type JobStatus, type JsonValue } from "../schema";
import { bigintArray, textArray } from "./sql-arrays";

/** What a caller asks to run. */
export interface NewJob {
  kind: string;
  payload: JsonValue;
  /** Dedupes against PENDING jobs with the same key (see the schema note). */
  idempotencyKey?: string;
  /** Not before this time (default now). */
  runAt?: Date;
  maxAttempts?: number;
}

/** One row of the per-kind, per-status counts. */
export interface JobCount {
  kind: string;
  status: JobStatus;
  count: number;
}

/**
 * A job as a runner holds it. `lockedUntil` doubles as the claim's fencing
 * token: every claim sets it, and a reclaim always sets a later one, so an
 * outcome written with a stale token (the job overran its lease and another
 * runner took it) matches nothing.
 */
export type ClaimedJob = Job & { lockedUntil: Date };

/** What {@link JobRepository.retry} did. */
export type JobRetryResult = "retried" | "not-failed" | "already-queued";

/** Statuses a pending idempotency key is unique within. */
const PENDING = sql`${jobs.status} in ('queued', 'running')`;

export interface JobRepository {
  /**
   * Queue a job. With an `idempotencyKey` already pending, nothing is queued and
   * the existing job's id comes back with `created: false`.
   */
  enqueue(job: NewJob): Promise<{ id: number; created: boolean }>;
  /**
   * Atomically claim up to `limit` due jobs of the given kinds: queued ones whose
   * `runAt` has come, and running ones whose lease lapsed (a crashed runner) with
   * attempts left. Claimed jobs become `running`, leased until `now + leaseMs`,
   * with `attempts` incremented. `FOR UPDATE SKIP LOCKED` means concurrent
   * runners claim disjoint sets, without blocking each other.
   */
  claim(input: { kinds: readonly string[]; limit: number; leaseMs: number; now: Date }): Promise<ClaimedJob[]>;
  /**
   * Mark a claimed job finished. This and the other outcome writes return
   * false, changing nothing, when the claim is no longer the job's current one.
   */
  complete(job: ClaimedJob, now: Date): Promise<boolean>;
  /** Record a failed attempt: retry at `retryAt`, or fail for good when null. */
  fail(job: ClaimedJob, error: string, retryAt: Date | null, now: Date): Promise<boolean>;
  /**
   * Hand a claimed job back without spending its attempt (e.g. its handler was
   * unregistered between claim and run).
   */
  release(job: ClaimedJob, now: Date): Promise<boolean>;
  /**
   * Fail running jobs whose lease lapsed with no attempts left: their runner
   * died (or overran) on the final attempt, so nothing will ever finish them.
   * Returns how many.
   */
  failAbandoned(now: Date): Promise<number>;
  /** Job counts per kind and status. */
  counts(): Promise<JobCount[]>;
  /** The most recently failed jobs, newest first. */
  recentFailures(limit: number): Promise<Job[]>;
  /**
   * Re-queue a failed job with a fresh set of attempts. Refused when it isn't
   * failed, or when a pending job already holds its idempotency key.
   */
  retry(id: number, now: Date): Promise<JobRetryResult>;
  /** Delete finished jobs (done before `doneBefore`, failed before `failedBefore`). */
  prune(input: { doneBefore: Date; failedBefore: Date }): Promise<number>;
}

/** The row `job` names, while its claim is still the current one. */
function heldBy(job: ClaimedJob) {
  return and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedUntil, job.lockedUntil));
}

/** Build a {@link JobRepository} over a {@link DB} handle. */
export function createJobRepository(db: DB): JobRepository {
  return {
    async enqueue({ kind, payload, idempotencyKey, runAt, maxAttempts }) {
      const inserted = await db
        .insert(jobs)
        .values({
          kind,
          // Serialized explicitly: Drizzle would send a JS `null` payload as SQL
          // NULL (refused by NOT NULL), not as the JSON value `null`.
          payload: sql`${JSON.stringify(payload)}::jsonb`,
          idempotencyKey: idempotencyKey ?? null,
          ...(runAt ? { runAt } : {}),
          ...(maxAttempts ? { maxAttempts } : {}),
        })
        .onConflictDoNothing({ target: jobs.idempotencyKey, where: PENDING })
        .returning({ id: jobs.id });
      if (inserted[0]) return { id: inserted[0].id, created: true };
      // Only an idempotency key can conflict: return the pending job it names.
      const [existing] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.idempotencyKey, idempotencyKey ?? ""), PENDING))
        .limit(1);
      if (!existing) throw new Error("Job enqueue conflicted but no pending job holds the key");
      return { id: existing.id, created: false };
    },

    async claim({ kinds, limit, leaseMs, now }) {
      if (kinds.length === 0 || limit <= 0) return [];
      const leaseEnd = new Date(now.getTime() + leaseMs);
      const rows = await db.execute<Record<string, unknown>>(sql`
        UPDATE jobs
           SET status = 'running', locked_until = ${leaseEnd.toISOString()}::timestamptz,
               attempts = attempts + 1, updated_at = ${now.toISOString()}::timestamptz
         WHERE id IN (
           SELECT id FROM jobs
            WHERE kind = ANY(${textArray(kinds)})
              AND ((status = 'queued' AND run_at <= ${now.toISOString()}::timestamptz)
                OR (status = 'running' AND locked_until < ${now.toISOString()}::timestamptz
                    AND attempts < max_attempts))
            ORDER BY run_at, id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
        RETURNING id
      `);
      const ids = [...rows].map((row) => Number(row.id));
      if (ids.length === 0) return [];
      const claimed = await db
        .select()
        .from(jobs)
        .where(sql`${jobs.id} = ANY(${bigintArray(ids)})`)
        .orderBy(asc(jobs.runAt), asc(jobs.id));
      // Every row was just leased by this claim; a row whose lease is already
      // gone was re-taken in between, so it isn't ours to run.
      return claimed.filter((job): job is ClaimedJob => job.lockedUntil?.getTime() === leaseEnd.getTime());
    },

    async complete(job, now) {
      const done = await db
        .update(jobs)
        .set({ status: "done", lockedUntil: null, finishedAt: now, updatedAt: now, lastError: null })
        .where(heldBy(job))
        .returning({ id: jobs.id });
      return done.length > 0;
    },

    async fail(job, error, retryAt, now) {
      const failed = await db
        .update(jobs)
        .set(
          retryAt
            ? { status: "queued", runAt: retryAt, lockedUntil: null, lastError: error, updatedAt: now }
            : { status: "failed", lockedUntil: null, lastError: error, updatedAt: now, finishedAt: now },
        )
        .where(heldBy(job))
        .returning({ id: jobs.id });
      return failed.length > 0;
    },

    async release(job, now) {
      const released = await db
        .update(jobs)
        .set({
          status: "queued",
          lockedUntil: null,
          attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
          updatedAt: now,
        })
        .where(heldBy(job))
        .returning({ id: jobs.id });
      return released.length > 0;
    },

    async failAbandoned(now) {
      const failed = await db
        .update(jobs)
        .set({
          status: "failed",
          lockedUntil: null,
          lastError: "Abandoned: its lease ran out on the final attempt (the runner stopped or overran)",
          updatedAt: now,
          finishedAt: now,
        })
        .where(
          and(
            eq(jobs.status, "running"),
            lt(jobs.lockedUntil, now),
            sql`${jobs.attempts} >= ${jobs.maxAttempts}`,
          ),
        )
        .returning({ id: jobs.id });
      return failed.length;
    },

    async counts() {
      const rows = await db
        .select({ kind: jobs.kind, status: jobs.status, count: count() })
        .from(jobs)
        .groupBy(jobs.kind, jobs.status)
        .orderBy(asc(jobs.kind), asc(jobs.status));
      return rows;
    },

    recentFailures(limit) {
      return db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "failed"))
        .orderBy(desc(jobs.finishedAt), desc(jobs.id))
        .limit(limit);
    },

    async retry(id, now) {
      try {
        const retried = await db
          .update(jobs)
          .set({ status: "queued", attempts: 0, runAt: now, finishedAt: null, updatedAt: now })
          .where(and(eq(jobs.id, id), eq(jobs.status, "failed")))
          .returning({ id: jobs.id });
        return retried.length > 0 ? "retried" : "not-failed";
      } catch (error) {
        // The partial unique index: the same work (its idempotency key) has
        // been queued again since this job failed.
        if (isUniqueViolation(error)) return "already-queued";
        throw error;
      }
    },

    async prune({ doneBefore, failedBefore }) {
      // Counted in SQL: RETURNING every id would ship one row per job to the app.
      const [row] = await db.execute<{ n: number | string }>(sql`
        WITH removed AS (
          DELETE FROM jobs
           WHERE (status = 'done' AND finished_at < ${doneBefore.toISOString()}::timestamptz)
              OR (status = 'failed' AND finished_at < ${failedBefore.toISOString()}::timestamptz)
          RETURNING 1
        )
        SELECT count(*) AS n FROM removed
      `);
      return Number(row?.n ?? 0);
    },
  };
}

