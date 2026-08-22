import type { DB, PluginLogger } from "@bunbooru/plugin-sdk";

import { createOutboxWorker, type OutboxWorker } from "./outbox";
import type { TransportResolver } from "./transport";

/**
 * How often the outbox worker polls for due messages (ms). Overridable via
 * `SMTP_OUTBOX_POLL_MS` for tests/tuning; defaults to 15s — brisk enough that a
 * password-reset mail leaves promptly, cheap enough as an idle poll.
 */
const DEFAULT_POLL_MS = 15_000;

/** Resolve the poll interval from env, falling back to {@link DEFAULT_POLL_MS}. */
function pollIntervalMs(env: Record<string, string | undefined> = Bun.env): number {
  const raw = env.SMTP_OUTBOX_POLL_MS?.trim();
  if (!raw) return DEFAULT_POLL_MS;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_POLL_MS;
}

/** Inputs for {@link startWorker}. */
export interface StartWorkerDeps {
  db: DB;
  resolver: TransportResolver;
  log: PluginLogger;
}

/**
 * Start the background outbox worker at the configured poll interval. Thin
 * wrapper over {@link createOutboxWorker} that owns the interval policy.
 */
export function startWorker(deps: StartWorkerDeps): OutboxWorker {
  return createOutboxWorker({ ...deps, intervalMs: pollIntervalMs() });
}
