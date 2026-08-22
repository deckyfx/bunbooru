/**
 * Retry policy for the mail outbox — pure, so the schedule and the retry budget
 * are unit-testable without a database or a clock.
 */

/**
 * Maximum delivery attempts before a row is considered permanently failed. Kept
 * small: SMTP failures that survive this many exponentially-spaced retries are
 * almost always configuration/address problems a retry won't fix. Permanently
 * failed rows stay visible in the admin page (never deleted).
 */
export const MAX_SEND_ATTEMPTS = 5;

/** Base delay for the first retry (ms). */
export const BASE_BACKOFF_MS = 60_000;

/** Ceiling for a single backoff interval (ms) — 1 hour. */
export const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Delay before the next attempt, given how many attempts have ALREADY failed.
 * Exponential: `base * 2^(attempts-1)`, clamped to {@link MAX_BACKOFF_MS}.
 *
 * - after 1 failure  → base (60s)
 * - after 2 failures → 120s
 * - after 3 failures → 240s … capped at 1h
 *
 * `attempts <= 0` returns 0 (the first send should fire immediately).
 */
export function backoffDelayMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  const exp = BASE_BACKOFF_MS * 2 ** (attempts - 1);
  // Guard against 2**n overflowing past the cap for large `attempts`.
  return Math.min(exp, MAX_BACKOFF_MS);
}

/** Absolute time of the next attempt after `attempts` failures, from `now`. */
export function nextAttemptAt(attempts: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + backoffDelayMs(attempts));
}

/**
 * Whether a row has exhausted its retry budget (no further attempts). True once
 * `attempts` reaches {@link MAX_SEND_ATTEMPTS}.
 */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_SEND_ATTEMPTS;
}
