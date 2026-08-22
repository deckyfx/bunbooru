import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import type { DB, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { isExhausted, MAX_SEND_ATTEMPTS, nextAttemptAt } from "./backoff";
import { maskEmail } from "./mask";
import { mailOutbox } from "./schema";
import { getMailSettings, type MailSettings } from "./settings";
import type { SmtpTransport } from "./transport";

/** How many due rows one drain pass attempts (bounds work per tick). */
const DRAIN_BATCH = 10;

/**
 * Upper bound on a single send attempt, used ONLY to size the claim lease. It
 * must stay >= the transport's combined connection/greeting/socket timeouts (≈50s;
 * see `createNodemailerTransport`) — those are the REAL per-send cap: they abort
 * the socket, so a timeout there is a genuine failure that's safe to retry.
 *
 * We deliberately do NOT wrap send() in our own Promise.race timeout: that
 * wouldn't cancel the underlying send, so an "abandoned" send could still deliver
 * while the retry delivers too — a duplicate email. Enforce the cap in the
 * transport (which can actually abort), not here.
 */
const PER_SEND_BUDGET_MS = 60 * 1000;

/**
 * How long a claimed row is leased before it becomes due again. The claim pushes
 * `nextAttemptAt` this far out so a concurrent worker (or the next tick) won't
 * re-select a row mid-send; the send outcome then overwrites it (`sentAt` on
 * success, the backoff schedule on failure).
 *
 * The lease MUST outlast a full SERIAL drain of the batch — the claim leases the
 * whole batch up front, then sends one row at a time, so a late row could
 * otherwise fall due again (and be sent twice) while the worker is still on
 * earlier rows. Sized as batch × per-send budget + margin. If the process dies
 * mid-drain the row retries after the lease (the unique idempotency key stops a
 * duplicate ENQUEUE, not a duplicate SEND — hence the lease must not expire early).
 */
const CLAIM_LEASE_MS = DRAIN_BATCH * PER_SEND_BUDGET_MS + 60 * 1000;

/**
 * Enqueue a message for delivery — idempotent on `idempotencyKey`. A duplicate
 * key (a retried Core send) is a no-op, not a second email, which is what makes
 * `MailProvider.send()` at-most-once in practice. Returns whether a NEW row was
 * inserted (false = already queued/sent).
 */
export async function enqueue(db: DB, mail: OutgoingMail): Promise<boolean> {
  const inserted = await db
    .insert(mailOutbox)
    .values({
      idempotencyKey: mail.idempotencyKey,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html ?? null,
    })
    .onConflictDoNothing({ target: mailOutbox.idempotencyKey })
    .returning({ id: mailOutbox.id });
  return inserted.length > 0;
}

/**
 * Compose the envelope sender from non-secret settings. Returns null when no
 * from-address is configured — the worker then HOLDS the row (a config problem
 * the admin fixes) rather than burning the retry budget on it.
 */
export function resolveFrom(settings: MailSettings): string | null {
  // Strip control chars (CR/LF included) from BOTH parts so an admin-set value
  // can't inject extra SMTP headers via the From line (email header injection).
  const address = settings.fromAddress?.trim().replace(/\p{Cc}/gu, "");
  if (!address) return null;
  const name = settings.fromName?.trim().replace(/\p{Cc}/gu, "");
  if (!name) return address;
  // Quote + escape the display name so specials (commas, quotes, angle brackets)
  // can't break out of the phrase.
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

/** Counts from one drain pass, for logging/tests. */
export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  held: number;
}

/** Dependencies for {@link drainOnce} — injectable so tests control time. */
export interface DrainDeps {
  db: DB;
  transport: SmtpTransport;
  log: PluginLogger;
  /** Clock, injectable for deterministic tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Drain up to {@link DRAIN_BATCH} due rows once. For each row:
 * - settings disabled OR no from-address → HELD (untouched, retried next pass).
 * - send succeeds → `sentAt` set.
 * - send throws → `attempts` incremented, `lastError` recorded, `nextAttemptAt`
 *   pushed out by the exponential backoff; once `attempts` hits the budget the
 *   row is no longer due and stays visible as permanently failed.
 */
export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  const { db, transport, log } = deps;
  const now = deps.now ?? (() => new Date());
  const result: DrainResult = { attempted: 0, sent: 0, failed: 0, held: 0 };

  const settings = await getMailSettings(db);
  const from = resolveFrom(settings);

  const isDue = and(
    isNull(mailOutbox.sentAt),
    lte(mailOutbox.attempts, MAX_SEND_ATTEMPTS - 1),
    lte(mailOutbox.nextAttemptAt, now()),
  );

  // Sending is paused or misconfigured: HOLD (don't claim) so nothing burns the
  // retry budget — count the backlog for the log without touching rows.
  if (!settings.enabled || !from) {
    const due = await db
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(isDue)
      .limit(DRAIN_BATCH);
    if (due.length > 0) {
      log.warn("mail_outbox_held", {
        reason: settings.enabled ? "no_from_address" : "disabled",
        held: due.length,
      });
      result.held = due.length;
    }
    return result;
  }

  // Atomically CLAIM up to a batch of due rows: an UPDATE that leases them (pushes
  // `nextAttemptAt` out) gated by a `FOR UPDATE SKIP LOCKED` subquery, so two
  // workers (or overlapping ticks) can never grab the same row — each claims a
  // disjoint set and the loser skips locked rows instead of blocking.
  const claimBatch = db
    .select({ id: mailOutbox.id })
    .from(mailOutbox)
    .where(isDue)
    .orderBy(asc(mailOutbox.nextAttemptAt))
    .limit(DRAIN_BATCH)
    .for("update", { skipLocked: true });
  const due = await db
    .update(mailOutbox)
    .set({ nextAttemptAt: new Date(now().getTime() + CLAIM_LEASE_MS) })
    .where(inArray(mailOutbox.id, claimBatch))
    .returning();

  for (const row of due) {
    result.attempted += 1;
    try {
      // Each send is bounded by the transport's own connection/greeting/socket
      // timeouts (which abort the socket on expiry — a real, retry-safe failure).
      // We do NOT add our own timeout race here; see PER_SEND_BUDGET_MS.
      await transport.send({
        from: from as string, // held above when null
        to: row.to,
        subject: row.subject,
        text: row.text,
        html: row.html ?? undefined,
        replyTo: settings.replyTo ?? undefined,
      });
      await db
        .update(mailOutbox)
        .set({ sentAt: now(), lastError: null, attempts: row.attempts + 1 })
        .where(eq(mailOutbox.id, row.id));
      result.sent += 1;
      log.info("mail_sent", {
        to: maskEmail(row.to),
        subject: row.subject,
        idempotencyKey: row.idempotencyKey,
        attempt: row.attempts + 1,
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(mailOutbox)
        .set({ attempts, lastError: message, nextAttemptAt: nextAttemptAt(attempts, now()) })
        .where(eq(mailOutbox.id, row.id));
      result.failed += 1;
      log.warn("mail_send_failed", {
        to: maskEmail(row.to),
        subject: row.subject,
        idempotencyKey: row.idempotencyKey,
        attempt: attempts,
        permanent: isExhausted(attempts),
        error: message,
      });
    }
  }
  return result;
}

/** A running outbox worker with a stop handle. */
export interface OutboxWorker {
  /** Stop the interval (idempotent). */
  stop(): void;
}

/** Dependencies for {@link createOutboxWorker}. */
export interface WorkerDeps extends DrainDeps {
  /** Poll interval (ms). */
  intervalMs: number;
}

/**
 * Start a background worker that drains the outbox every `intervalMs`. Overlapping
 * ticks are prevented (a slow drain doesn't stack). The timer is `unref`'d so it
 * never keeps the process alive on its own.
 */
export function createOutboxWorker(deps: WorkerDeps): OutboxWorker {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await drainOnce(deps);
    } catch (error) {
      deps.log.error("mail_outbox_drain_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs);
  // Node/Bun timers expose unref(); guard in case of an exotic host.
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Outbox counts for the admin status view. */
export interface OutboxCounts {
  queued: number;
  sent: number;
  failed: number;
}

/** Aggregate outbox state for the admin page (queued / sent / permanently failed). */
export async function outboxCounts(db: DB): Promise<OutboxCounts> {
  const rows = await db
    .select({
      queued: sql<number>`count(*) filter (where ${mailOutbox.sentAt} is null and ${mailOutbox.attempts} < ${MAX_SEND_ATTEMPTS})::int`,
      sent: sql<number>`count(*) filter (where ${mailOutbox.sentAt} is not null)::int`,
      failed: sql<number>`count(*) filter (where ${mailOutbox.sentAt} is null and ${mailOutbox.attempts} >= ${MAX_SEND_ATTEMPTS})::int`,
    })
    .from(mailOutbox);
  return rows[0] ?? { queued: 0, sent: 0, failed: 0 };
}
