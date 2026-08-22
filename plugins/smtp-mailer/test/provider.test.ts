import { describe, expect, it, mock } from "bun:test";

import type { DB, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { createMailProvider } from "../src/provider";
import type { SmtpTransport } from "../src/transport";

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

const MAIL: OutgoingMail = {
  to: "alice@example.com",
  subject: "Hello",
  text: "secret body — must never be logged",
  idempotencyKey: "test:1",
};

describe("createMailProvider — log-only mode (no transport)", () => {
  it("logs the message instead of dialing SMTP, and never touches the db", () => {
    const log = fakeLogger();
    const insert = mock(() => {
      throw new Error("db must not be used in log-only mode");
    });
    const db = { insert } as unknown as DB;
    const provider = createMailProvider({ db, log, transport: null });

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
    const provider = createMailProvider({ db: {} as DB, log: fakeLogger(), transport: null });
    await expect(provider.verify()).resolves.toBeUndefined();
  });
});

describe("createMailProvider — SMTP mode", () => {
  it("send() ENQUEUES (never dials the transport inline)", async () => {
    const log = fakeLogger();
    const send = mock(async () => {});
    const verify = mock(async () => {});
    const transport: SmtpTransport = { send, verify };
    const insertChain = {
      values: () => insertChain,
      onConflictDoNothing: () => insertChain,
      returning: () => Promise.resolve([{ id: 1 }]),
    };
    const insert = mock(() => insertChain);
    const db = { insert } as unknown as DB;

    const provider = createMailProvider({ db, log, transport });
    await provider.send(MAIL);

    expect(insert).toHaveBeenCalledTimes(1); // enqueued
    expect(send).not.toHaveBeenCalled(); // NOT sent inline
    const entry = log.calls.find((c) => c.message === "mail_enqueued");
    expect(entry?.data?.duplicate).toBe(false);
  });

  it("send() reports a duplicate when the key already exists", async () => {
    const log = fakeLogger();
    const transport: SmtpTransport = { send: mock(async () => {}), verify: mock(async () => {}) };
    const insertChain = {
      values: () => insertChain,
      onConflictDoNothing: () => insertChain,
      returning: () => Promise.resolve([]), // conflict → no row returned
    };
    const db = { insert: () => insertChain } as unknown as DB;

    const provider = createMailProvider({ db, log, transport });
    await provider.send(MAIL);

    expect(log.calls.find((c) => c.message === "mail_enqueued")?.data?.duplicate).toBe(true);
  });

  it("verify() probes the transport", async () => {
    const verify = mock(async () => {});
    const transport: SmtpTransport = { send: mock(async () => {}), verify };
    const provider = createMailProvider({ db: {} as DB, log: fakeLogger(), transport });
    await provider.verify();
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
