import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The mail outbox — one row per accepted message. `MailProvider.send()` enqueues
 * here and returns (accepted != delivered); a background worker drains it with
 * exponential backoff and a bounded retry budget.
 *
 * State is derived, not a column:
 * - queued        → `sentAt` null, `attempts` < budget, `nextAttemptAt` <= now
 * - sent          → `sentAt` set
 * - failed (perm) → `sentAt` null, `attempts` >= budget (kept visible, never deleted)
 *
 * `idempotencyKey` is UNIQUE so a retried send (same key) is at-most-once: the
 * enqueue is a no-op on conflict rather than a duplicate email.
 */
export const mailOutbox = pgTable("mail_outbox", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  /** Stable dedupe key from Core (e.g. `password-reset:<tokenId>`). */
  idempotencyKey: text("idempotency_key").notNull().unique(),
  /** Recipient address (logged only masked; never the body). */
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  /** Plain-text body (required by the contract). Never logged. */
  text: text("text").notNull(),
  /** Optional HTML alternative. Never logged. */
  html: text("html"),
  /** Delivery attempts made so far; drives the backoff schedule + retry budget. */
  attempts: integer("attempts").notNull().default(0),
  /** Earliest time the worker may (re)try this row. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  /** Last provider error (message only), for the admin view. Never the body. */
  lastError: text("last_error"),
  /** Set once delivery is accepted by the SMTP server. Null while queued/failed. */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Non-secret operational settings, surfaced on the admin page. A single-row
 * table keyed by a fixed {@link SETTINGS_ROW_ID}; credentials NEVER live here —
 * they come from env (see `config.ts`) and are never returned to a browser.
 */
export const mailSettings = pgTable("mail_settings", {
  /** Fixed singleton id; only {@link SETTINGS_ROW_ID} is ever written. */
  id: integer("id").primaryKey(),
  /** Display name on the envelope sender (e.g. "Bunbooru"). */
  fromName: text("from_name"),
  /** Envelope sender address. The provider owns this; Core cannot spoof it. */
  fromAddress: text("from_address"),
  /** Optional Reply-To address. */
  replyTo: text("reply_to"),
  // ─── SMTP connection (admin-editable via the UI; no env) ───────────────────
  /** SMTP server host. NULL → log-only mode (nothing dialed). */
  host: text("host"),
  /** SMTP port (465 implicit-TLS, 587/25 STARTTLS). NULL → default 587. */
  port: integer("port"),
  /** true → implicit TLS (465); false → STARTTLS. */
  secure: boolean("secure").notNull().default(false),
  /** SMTP AUTH username (paired with {@link password}); NULL for open relays. */
  username: text("username"),
  /**
   * SMTP AUTH password. Stored here (plugin-owned table); the API NEVER returns
   * it to a browser — the admin form is write-only (see the routes in index.ts).
   *
   * DECISION (re: CodeRabbit "encrypt at rest"): kept PLAINTEXT for now, on
   * purpose. This is the standard self-hosted posture (Gitea/WordPress/Nextcloud)
   * — the database is already the trust boundary, and it's never exposed to a
   * browser. Encryption-at-rest would reintroduce a managed key (an env
   * dependency we just removed), key-rotation handling, and a plaintext-migration
   * step — over-engineering at this early stage that's easy to get wrong. Revisit
   * if the threat model ever separates DB access from host/key access.
   */
  password: text("password"),
  /**
   * Operator kill-switch. When false, `send()` still enqueues (so nothing is
   * lost), but the worker holds delivery — useful to pause a misconfigured
   * server without dropping mail.
   */
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** The one row {@link mailSettings} ever holds (singleton config). */
export const SETTINGS_ROW_ID = 1;
