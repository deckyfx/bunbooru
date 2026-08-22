import { describe, expect, it } from "bun:test";

import { MailNotConfiguredError, MailProviderConflictError } from "../src/errors";
import type { MailProvider, OutgoingMail } from "../src/mail/mail-provider";
import { createLogMailProvider, createMailService } from "../src/mail/mail-service";

/** A provider that records what it's asked to send. */
function recordingProvider() {
  const sent: OutgoingMail[] = [];
  const provider: MailProvider = {
    send: async (mail) => void sent.push(mail),
    verify: async () => undefined,
  };
  return { provider, sent };
}

const sampleMail: OutgoingMail = {
  to: "a@example.com",
  subject: "hi",
  text: "body",
  idempotencyKey: "k:1",
};

describe("createMailService", () => {
  it("is unconfigured until a provider is installed", async () => {
    const mail = createMailService();
    expect(mail.isConfigured()).toBe(false);
    expect(mail.activeProviderId()).toBeNull();
    await expect(mail.send(sampleMail)).rejects.toBeInstanceOf(MailNotConfiguredError);
    await expect(mail.verify()).rejects.toBeInstanceOf(MailNotConfiguredError);
  });

  it("routes send/verify to the installed provider", async () => {
    const mail = createMailService();
    const { provider, sent } = recordingProvider();
    mail.setProvider(provider, "smtp-mailer");

    expect(mail.isConfigured()).toBe(true);
    expect(mail.activeProviderId()).toBe("smtp-mailer");
    await mail.send(sampleMail);
    expect(sent).toEqual([sampleMail]);
  });

  it("allows re-install from the same plugin but rejects a different one", () => {
    const mail = createMailService();
    const a = recordingProvider();
    const b = recordingProvider();
    mail.setProvider(a.provider, "smtp-mailer");
    // Same id: idempotent reload is fine.
    mail.setProvider(a.provider, "smtp-mailer");
    // Different id: fail fast rather than silently reroute mail.
    expect(() => mail.setProvider(b.provider, "ses-mailer")).toThrow(MailProviderConflictError);
  });
});

describe("createLogMailProvider", () => {
  it("logs without the body and never throws", async () => {
    const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const provider = createLogMailProvider({ info: (message, data) => logs.push({ message, data }) });

    await provider.send(sampleMail);
    await provider.verify();

    expect(logs).toHaveLength(1);
    // The body is never logged (it can carry a live token); the recipient is masked.
    expect(logs[0]?.data).toEqual({ to: "***@example.com", subject: "hi", idempotencyKey: "k:1" });
    expect(JSON.stringify(logs[0])).not.toContain("body");
  });
});
