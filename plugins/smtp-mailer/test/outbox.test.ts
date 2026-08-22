import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq, sql } from "drizzle-orm";

import type { DB, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { MAX_SEND_ATTEMPTS } from "../src/backoff";
import { drainOnce, enqueue, outboxCounts } from "../src/outbox";
import { mailOutbox } from "../src/schema";
import { updateMailSettings } from "../src/settings";
import type { SmtpTransport } from "../src/transport";

/**
 * Integration tests against a real Postgres (opt-in `TEST_DATABASE_URL`, same
 * rationale as the db-package tests). They lock down the outbox invariants:
 * idempotent enqueue, at-most-once via the unique key, the backoff schedule, and
 * the bounded retry budget (permanently-failed rows stay visible).
 *
 * The plugin can't import `@bunbooru/db` (boundary rule), so the handle is built
 * from `drizzle-orm` directly over the plugin's OWN schema and cast to `DB`.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

const noopLog: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** A transport whose send/verify outcome the test controls. */
function transportThatSucceeds(): SmtpTransport {
  return { send: mock(async () => {}), verify: mock(async () => {}) };
}
function transportThatFails(message: string): SmtpTransport {
  return {
    send: mock(async () => {
      throw new Error(message);
    }),
    verify: mock(async () => {}),
  };
}

const MAIL: OutgoingMail = {
  to: "alice@example.com",
  subject: "Hello",
  text: "body",
  idempotencyKey: "reset:1",
};

describe.skipIf(!TEST_DATABASE_URL)("mail outbox (integration)", () => {
  let db: DB;
  let client: SQL;

  beforeAll(async () => {
    // NOTE: this suite issues DESTRUCTIVE DDL (DROP/CREATE its own tables), so
    // TEST_DATABASE_URL MUST be a dedicated throwaway database — the same opt-in
    // contract the db-package integration tests rely on (they TRUNCATE). It is
    // intentionally allowed to equal DATABASE_URL: CI provisions ONE disposable
    // Postgres and uses it for both.
    client = new SQL(TEST_DATABASE_URL as string);
    db = drizzle({ client }) as unknown as DB;
    // Self-contained schema (plugin tables aren't part of Core's migrations).
    await db.execute(sql`DROP TABLE IF EXISTS mail_outbox`);
    await db.execute(sql`DROP TABLE IF EXISTS mail_settings`);
    await db.execute(sql`
      CREATE TABLE mail_outbox (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        idempotency_key text NOT NULL UNIQUE,
        "to" text NOT NULL,
        subject text NOT NULL,
        text text NOT NULL,
        html text,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error text,
        sent_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE TABLE mail_settings (
        id integer PRIMARY KEY,
        from_name text,
        from_address text,
        reply_to text,
        enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  afterAll(async () => {
    // Close the pooled connection so the suite doesn't leak it.
    await client?.close();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE mail_outbox RESTART IDENTITY`);
    await db.execute(sql`TRUNCATE TABLE mail_settings`);
    // A valid sender so drainOnce actually attempts (rather than holding).
    await updateMailSettings(db, { fromAddress: "no-reply@example.com", enabled: true });
  });

  it("enqueue is idempotent on the idempotency key", async () => {
    expect(await enqueue(db, MAIL)).toBe(true); // new row
    expect(await enqueue(db, MAIL)).toBe(false); // duplicate → no-op
    const rows = await db.select().from(mailOutbox);
    expect(rows).toHaveLength(1);
  });

  it("drainOnce delivers a queued row and stamps sent_at", async () => {
    await enqueue(db, MAIL);
    const transport = transportThatSucceeds();
    const result = await drainOnce({ db, transport, log: noopLog });
    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    expect(transport.send).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(mailOutbox);
    expect(row).toBeDefined();
    expect(row?.sentAt).not.toBeNull();
  });

  it("drainOnce records a failure and pushes the next attempt out (backoff)", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    // Insert already-due relative to the injected clock — `enqueue` would default
    // next_attempt_at to the DB's real wall clock (well after `now`), leaving the
    // row not-yet-due and never attempted.
    await db.insert(mailOutbox).values({
      idempotencyKey: MAIL.idempotencyKey,
      to: MAIL.to,
      subject: MAIL.subject,
      text: MAIL.text,
      nextAttemptAt: new Date("2025-12-31T00:00:00.000Z"),
    });
    const result = await drainOnce({
      db,
      transport: transportThatFails("connection refused"),
      log: noopLog,
      now: () => now,
    });
    expect(result).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
    const [row] = await db.select().from(mailOutbox);
    expect(row).toBeDefined();
    expect(row?.sentAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("connection refused");
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("stops retrying once the budget is exhausted; the row stays visible as failed", async () => {
    // Seed a row one attempt short of the budget, already due.
    await db.insert(mailOutbox).values({
      idempotencyKey: "reset:doomed",
      to: "bob@example.com",
      subject: "x",
      text: "y",
      attempts: MAX_SEND_ATTEMPTS - 1,
      nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    const transport = transportThatFails("still failing");

    const first = await drainOnce({ db, transport, log: noopLog });
    expect(first).toMatchObject({ attempted: 1, failed: 1 });

    // Force the row DUE again so the second pass can only be skipped by the
    // budget filter (attempts >= MAX), not because backoff pushed it into the
    // future — that's what actually proves exhausted rows aren't retried.
    await db
      .update(mailOutbox)
      .set({ nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(mailOutbox.idempotencyKey, "reset:doomed"));
    const second = await drainOnce({ db, transport, log: noopLog });
    expect(second.attempted).toBe(0);

    const counts = await outboxCounts(db);
    expect(counts.failed).toBe(1);
    expect(counts.queued).toBe(0);
    const [row] = await db.select().from(mailOutbox).where(eq(mailOutbox.idempotencyKey, "reset:doomed"));
    expect(row).toBeDefined();
    expect(row?.attempts).toBe(MAX_SEND_ATTEMPTS); // still present, not deleted
  });

  it("holds (does not attempt) when delivery is disabled", async () => {
    await updateMailSettings(db, { enabled: false });
    await enqueue(db, MAIL);
    const transport = transportThatSucceeds();
    const result = await drainOnce({ db, transport, log: noopLog });
    expect(result).toMatchObject({ attempted: 0, held: 1 });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("two concurrent drains send a single row only once (atomic claim)", async () => {
    // One due row; two workers race to drain it. The atomic FOR UPDATE SKIP LOCKED
    // claim (or the lease it writes) must let only one worker take the row, so the
    // message is sent exactly once — the whole point of the claim over a plain read.
    await db.insert(mailOutbox).values({
      idempotencyKey: "reset:concurrent",
      to: MAIL.to,
      subject: MAIL.subject,
      text: MAIL.text,
      nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    // Drive the two workers over SEPARATE connections (second pooled client), so a
    // single pool serializing the statements can't mask a missing claim — the two
    // claims genuinely race at the database. The delay widens the send window.
    const client2 = new SQL(TEST_DATABASE_URL as string);
    const db2 = drizzle({ client: client2 }) as unknown as DB;
    let sends = 0;
    const transport: SmtpTransport = {
      send: mock(async () => {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }),
      verify: mock(async () => {}),
    };

    try {
      const [a, b] = await Promise.all([
        drainOnce({ db, transport, log: noopLog }),
        drainOnce({ db: db2, transport, log: noopLog }),
      ]);

      expect(sends).toBe(1);
      expect(a.sent + b.sent).toBe(1);
      const [row] = await db
        .select()
        .from(mailOutbox)
        .where(eq(mailOutbox.idempotencyKey, "reset:concurrent"));
      // Assert the row EXISTS and is sent — `row?.sentAt` alone would pass on a
      // missing row (undefined !== null).
      expect(row).toBeDefined();
      expect(row?.sentAt).not.toBeNull();
    } finally {
      await client2.close();
    }
  });
});
