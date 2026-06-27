import { CORE_DEPENDENCIES } from "@bunbooru/core";
import { EVENTS_PACKAGE } from "@bunbooru/events";

/**
 * `@bunbooru/worker` — background job runner.
 *
 * Consumes events and runs long-running jobs (thumbnail, OCR, AI, metadata).
 * Never exposes HTTP. Jobs are retryable, resumable, and idempotent, backed by
 * the Postgres job queue. Job runners land in later PRs.
 */
export const WORKER_BOOT = {
  core: CORE_DEPENDENCIES,
  events: EVENTS_PACKAGE,
} as const;
