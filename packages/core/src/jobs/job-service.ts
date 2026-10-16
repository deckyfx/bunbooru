import type { Job, JobCount, JobRepository, JobRetryResult, JsonValue } from "@bunbooru/db";

/** What a handler learns about the job it's running. */
export interface JobContext {
  id: number;
  /** 1 on the first try. */
  attempt: number;
  maxAttempts: number;
}

/**
 * Runs one kind of job. Throwing schedules a retry with backoff, until the
 * job's attempts are spent. A handler must be idempotent: a runner that dies
 * mid-job, or overruns its lease, means the job runs again.
 */
export interface JobHandler {
  run(payload: JsonValue, job: JobContext): Promise<void>;
  /** Attempts before the job fails for good (default {@link DEFAULT_MAX_ATTEMPTS}). */
  maxAttempts?: number;
  /**
   * How long one run may take before another runner may assume it died and
   * re-run it (default {@link DEFAULT_TIMEOUT_MS}). Size it well above the
   * handler's real worst case.
   */
  timeoutMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long finished jobs are kept before {@link JobService.prune} deletes them. */
export const JOB_RETENTION = { doneMs: 7 * DAY_MS, failedMs: 30 * DAY_MS };

/** Options for queueing a job. */
export interface EnqueueOptions {
  /** Skip queueing if a pending job already has this key (see the jobs table). */
  idempotencyKey?: string;
  /** Run no earlier than this. */
  runAt?: Date;
}

/** A failed job, as the admin console lists it. */
export interface JobFailure {
  id: number;
  kind: string;
  attempts: number;
  lastError: string | null;
  finishedAt: Date | null;
}

/** Thrown by {@link JobService.register} for a kind another owner holds, or a malformed one. */
export class JobKindConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobKindConflictError";
  }
}

/** A valid job kind: `<owner>:<name>`, lowercase, digits, `-` and `_`. */
const KIND_RE = /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/;

/**
 * The durable job queue's front door: queue work, and hold the handlers a
 * runner executes. Handlers are registered per owner (a plugin id, or `core`),
 * like search providers, so a plugin's handlers exist exactly while it's
 * active. Jobs of a kind with no handler simply wait (a deactivated plugin's
 * work resumes when it's reactivated).
 */
export interface JobService {
  enqueue(kind: string, payload: JsonValue, options?: EnqueueOptions): Promise<{ id: number; created: boolean }>;
  /** Install `handlers` (keyed by full kind) for `ownerId`, replacing its previous set. All-or-nothing. */
  register(ownerId: string, handlers: Readonly<Record<string, JobHandler>>): void;
  unregister(ownerId: string): void;
  /** The handler for `kind`, if one is registered. */
  handler(kind: string): JobHandler | undefined;
  /** Every kind that currently has a handler. */
  kinds(): string[];
  counts(): Promise<JobCount[]>;
  recentFailures(limit?: number): Promise<JobFailure[]>;
  /**
   * Re-queue a failed job with fresh attempts. `not-failed`: no failed job has
   * that id. `already-queued`: the same work (its idempotency key) is pending.
   */
  retry(id: number): Promise<JobRetryResult>;
  /**
   * Delete finished jobs: done ones older than `doneMs`, failed ones older than
   * `failedMs` (kept longer, for the admin console). Returns how many went.
   */
  prune(retention?: { doneMs: number; failedMs: number }): Promise<number>;
  /** Called after every enqueue (the runner uses it to wake up immediately). */
  onEnqueue(listener: () => void): void;
  /** The repository, for the runner. */
  readonly repository: JobRepository;
}

/** Build a {@link JobService} over a {@link JobRepository}. */
export function createJobService(repository: JobRepository, now: () => Date = () => new Date()): JobService {
  const byKind = new Map<string, { ownerId: string; handler: JobHandler }>();
  const listeners: (() => void)[] = [];

  const toFailure = (job: Job): JobFailure => ({
    id: job.id,
    kind: job.kind,
    attempts: job.attempts,
    lastError: job.lastError,
    finishedAt: job.finishedAt,
  });

  return {
    repository,

    async enqueue(kind, payload, options = {}) {
      if (!KIND_RE.test(kind)) throw new JobKindConflictError(`"${kind}" is not a valid job kind`);
      const handler = byKind.get(kind)?.handler;
      const queued = await repository.enqueue({
        kind,
        payload,
        idempotencyKey: options.idempotencyKey,
        // Stamped from this service's clock, the same one the runner claims by.
        runAt: options.runAt ?? now(),
        maxAttempts: handler?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      });
      if (queued.created) for (const listener of listeners) listener();
      return queued;
    },

    register(ownerId, handlers) {
      for (const kind of Object.keys(handlers)) {
        if (!KIND_RE.test(kind)) throw new JobKindConflictError(`"${kind}" from ${ownerId} is not a valid job kind`);
        const existing = byKind.get(kind);
        if (existing && existing.ownerId !== ownerId) {
          throw new JobKindConflictError(`Job kind "${kind}" from ${ownerId} is already handled by ${existing.ownerId}`);
        }
      }
      for (const [kind, entry] of byKind) if (entry.ownerId === ownerId) byKind.delete(kind);
      for (const [kind, handler] of Object.entries(handlers)) byKind.set(kind, { ownerId, handler });
      // Work for these kinds may already be waiting.
      for (const listener of listeners) listener();
    },

    unregister(ownerId) {
      for (const [kind, entry] of byKind) if (entry.ownerId === ownerId) byKind.delete(kind);
    },

    handler(kind) {
      return byKind.get(kind)?.handler;
    },

    kinds() {
      return [...byKind.keys()];
    },

    counts() {
      return repository.counts();
    },

    async recentFailures(limit = 20) {
      return (await repository.recentFailures(limit)).map(toFailure);
    },

    retry(id) {
      return repository.retry(id, now());
    },

    prune({ doneMs, failedMs } = JOB_RETENTION) {
      const at = now().getTime();
      return repository.prune({ doneBefore: new Date(at - doneMs), failedBefore: new Date(at - failedMs) });
    },

    onEnqueue(listener) {
      listeners.push(listener);
    },
  };
}
