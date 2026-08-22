import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import type { DB, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { isExhausted, MAX_SEND_ATTEMPTS, nextAttemptAt } from "./backoff";
import { maskEmail } from "./mask";
import { mailOutbox } from "./schema";
import { getMailSettings, type MailSettings } from "./settings";
import type { SmtpTransport } from "./transport";

/** How many due rows one drain pass attempts (bounds work per tick). */
const DRAIN_BATCH = 20;

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
  const address = settings.fromAddress?.trim();
  if (!address) return null;
  const name = settings.fromName?.trim();
  return name ? `${name} <${address}>` : address;
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

  const due = await db
    .select()
    .from(mailOutbox)
    .where(
      and(
        isNull(mailOutbox.sentAt),
        lte(mailOutbox.attempts, MAX_SEND_ATTEMPTS - 1),
        lte(mailOutbox.nextAttemptAt, now()),
      ),
    )
    .orderBy(asc(mailOutbox.nextAttemptAt))
    .limit(DRAIN_BATCH);

  if (due.length > 0 && (!settings.enabled || !from)) {
    // Hold everything: sending is paused or misconfigured. Log once, don't touch rows.
    log.warn("mail_outbox_held", {
      reason: settings.enabled ? "no_from_address" : "disabled",
      held: due.length,
    });
    result.held = due.length;
    return result;
  }

  for (const row of due) {
    result.attempted += 1;
    try {
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
