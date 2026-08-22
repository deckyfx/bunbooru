import { SQL } from "bun";
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
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

  beforeAll(async () => {
    db = drizzle({ client: new SQL(TEST_DATABASE_URL as string) }) as unknown as DB;
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
    expect(row?.sentAt).not.toBeNull();
  });

  it("drainOnce records a failure and pushes the next attempt out (backoff)", async () => {
    await enqueue(db, MAIL);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await drainOnce({
      db,
      transport: transportThatFails("connection refused"),
      log: noopLog,
      now: () => now,
    });
    expect(result).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
    const [row] = await db.select().from(mailOutbox);
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

    // Now exhausted → no longer due → not attempted again.
    const second = await drainOnce({ db, transport, log: noopLog });
    expect(second.attempted).toBe(0);

    const counts = await outboxCounts(db);
    expect(counts.failed).toBe(1);
    expect(counts.queued).toBe(0);
    const [row] = await db.select().from(mailOutbox).where(eq(mailOutbox.idempotencyKey, "reset:doomed"));
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
});
