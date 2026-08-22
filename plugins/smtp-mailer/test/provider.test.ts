import { describe, expect, it, mock } from "bun:test";

import type { DB, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { createMailProvider } from "../src/provider";
import type { SmtpTransport, TransportResolver } from "../src/transport";

/** A logger that records every call, for asserting logging discipline. */
function fakeLogger(): PluginLogger & { calls: Array<{ level: string; message: string; data?: Record<string, unknown> }> } {
  const calls: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    calls,
    info: (message, data) => calls.push({ level: "info", message, data }),
    warn: (message, data) => calls.push({ level: "warn", message, data }),
    error: (message, data) => calls.push({ level: "error", message, data }),
  };
}

/** A resolver over a fixed transport (null → log-only / not configured). */
function resolverFor(transport: SmtpTransport | null): TransportResolver {
  return {
    get: async () => transport,
    isConfigured: async () => transport !== null,
    close: async () => {},
  };
}

/** A mock transport whose calls are inspectable. */
function mockTransport(): SmtpTransport {
  return { send: mock(async () => {}), verify: mock(async () => {}), close: mock(async () => {}) };
}

/** A read-only db stub whose SELECT chain resolves to `rows` (for getMailSettings). */
function dbReturning(rows: unknown[]): DB {
  const chain = { from: () => chain, where: () => chain, limit: async () => rows };
  return { select: () => chain } as unknown as DB;
}

/** A saved settings row that's fully ready to send (enabled + host + from-address). */
const READY_ROW = {
  fromName: null,
  fromAddress: "no-reply@example.com",
  replyTo: null,
  enabled: true,
  host: "smtp.test",
  port: null,
  secure: false,
  username: null,
  password: null,
};

const MAIL: OutgoingMail = {
  to: "alice@example.com",
  subject: "Hello",
  text: "secret body — must never be logged",
  idempotencyKey: "test:1",
};

describe("createMailProvider — log-only mode (no host configured)", () => {
  it("logs the message instead of dialing SMTP, and never touches the db", () => {
    const log = fakeLogger();
    const insert = mock(() => {
      throw new Error("db must not be used in log-only mode");
    });
    const db = { insert } as unknown as DB;
    const provider = createMailProvider({ db, log, resolver: resolverFor(null) });

    return provider.send(MAIL).then(() => {
      expect(insert).not.toHaveBeenCalled();
      const entry = log.calls.find((c) => c.message === "mail_log_only");
      expect(entry).toBeDefined();
      // Recipient is masked; the body is never present in any log payload.
      expect(entry?.data?.to).toBe("a***e@example.com");
      const serialized = JSON.stringify(log.calls);
      expect(serialized).not.toContain("secret body");
    });
  });

  it("verify() resolves (nothing to probe)", async () => {
    const provider = createMailProvider({ db: {} as DB, log: fakeLogger(), resolver: resolverFor(null) });
    await expect(provider.verify()).resolves.toBeUndefined();
  });

  it("isConfigured() is false when no host is configured", async () => {
    // Empty settings → defaults (no host) → not ready.
    const provider = createMailProvider({ db: dbReturning([]), log: fakeLogger(), resolver: resolverFor(null) });
    expect(await provider.isConfigured?.()).toBe(false);
  });
});

describe("createMailProvider — SMTP mode", () => {
  it("send() ENQUEUES (never dials the transport inline)", async () => {
    const log = fakeLogger();
    const transport = mockTransport();
    const insertChain = {
      values: () => insertChain,
      onConflictDoNothing: () => insertChain,
      returning: () => Promise.resolve([{ id: 1 }]),
    };
    const insert = mock(() => insertChain);
    const db = { insert } as unknown as DB;

    const provider = createMailProvider({ db, log, resolver: resolverFor(transport) });
    await provider.send(MAIL);

    expect(insert).toHaveBeenCalledTimes(1); // enqueued
    expect(transport.send).not.toHaveBeenCalled(); // NOT sent inline
    const entry = log.calls.find((c) => c.message === "mail_enqueued");
    expect(entry?.data?.duplicate).toBe(false);
  });

  it("send() reports a duplicate when the key already exists", async () => {
    const log = fakeLogger();
    const insertChain = {
      values: () => insertChain,
      onConflictDoNothing: () => insertChain,
      returning: () => Promise.resolve([]), // conflict → no row returned
    };
    const db = { insert: () => insertChain } as unknown as DB;

    const provider = createMailProvider({ db, log, resolver: resolverFor(mockTransport()) });
    await provider.send(MAIL);

    expect(log.calls.find((c) => c.message === "mail_enqueued")?.data?.duplicate).toBe(true);
  });

  it("verify() probes the transport", async () => {
    const transport = mockTransport();
    const provider = createMailProvider({ db: {} as DB, log: fakeLogger(), resolver: resolverFor(transport) });
    await provider.verify();
    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it("isConfigured() is true when enabled with a host + from-address", async () => {
    const provider = createMailProvider({
      db: dbReturning([READY_ROW]),
      log: fakeLogger(),
      resolver: resolverFor(mockTransport()),
    });
    expect(await provider.isConfigured?.()).toBe(true);
  });

  it("isConfigured() is false when a host is set but delivery is disabled", async () => {
    const provider = createMailProvider({
      db: dbReturning([{ ...READY_ROW, enabled: false }]),
      log: fakeLogger(),
      resolver: resolverFor(mockTransport()),
    });
    expect(await provider.isConfigured?.()).toBe(false);
  });

  it("isConfigured() is false when a host is set but no from-address resolves", async () => {
    const provider = createMailProvider({
      db: dbReturning([{ ...READY_ROW, fromAddress: null }]),
      log: fakeLogger(),
      resolver: resolverFor(mockTransport()),
    });
    expect(await provider.isConfigured?.()).toBe(false);
  });

  it("isConfigured() is false when the from-address is malformed", async () => {
    const provider = createMailProvider({
      db: dbReturning([{ ...READY_ROW, fromAddress: "not-an-email" }]),
      log: fakeLogger(),
      resolver: resolverFor(mockTransport()),
    });
    expect(await provider.isConfigured?.()).toBe(false);
  });
});
