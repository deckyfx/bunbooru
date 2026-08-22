import { describe, expect, it } from "bun:test";

import { secretsFromSettings } from "../src/config";
import type { MailSettings } from "../src/settings";

/** A fully log-only settings row; tests override just the fields they exercise. */
const BASE: MailSettings = {
  fromName: null,
  fromAddress: null,
  replyTo: null,
  enabled: true,
  host: null,
  port: null,
  secure: false,
  username: null,
  password: null,
};

const settings = (over: Partial<MailSettings>): MailSettings => ({ ...BASE, ...over });

describe("secretsFromSettings", () => {
  it("returns null when no host is configured (log-only)", () => {
    expect(secretsFromSettings(BASE)).toBeNull();
    expect(secretsFromSettings(settings({ host: "   " }))).toBeNull(); // blank → null
  });

  it("keeps a valid saved port", () => {
    expect(secretsFromSettings(settings({ host: "smtp.test", port: 2525 }))?.port).toBe(2525);
  });

  it("falls back to 587 for STARTTLS when the port is absent or invalid", () => {
    expect(secretsFromSettings(settings({ host: "smtp.test", port: null, secure: false }))?.port).toBe(587);
    expect(secretsFromSettings(settings({ host: "smtp.test", port: 0, secure: false }))?.port).toBe(587);
    expect(secretsFromSettings(settings({ host: "smtp.test", port: 70000, secure: false }))?.port).toBe(587);
  });

  it("falls back to 465 for implicit TLS when the port is absent or invalid", () => {
    expect(secretsFromSettings(settings({ host: "smtp.test", port: null, secure: true }))?.port).toBe(465);
    expect(secretsFromSettings(settings({ host: "smtp.test", port: -1, secure: true }))?.port).toBe(465);
  });

  it("carries the secure flag through both ways", () => {
    expect(secretsFromSettings(settings({ host: "h", secure: true }))?.secure).toBe(true);
    expect(secretsFromSettings(settings({ host: "h", secure: false }))?.secure).toBe(false);
  });

  it("trims the host and username; empty username → undefined", () => {
    const s = secretsFromSettings(settings({ host: "  smtp.test  ", username: "  apikey  " }));
    expect(s?.host).toBe("smtp.test");
    expect(s?.user).toBe("apikey");
    expect(secretsFromSettings(settings({ host: "h", username: "   " }))?.user).toBeUndefined();
  });

  it("preserves a password verbatim (spaces kept); empty → undefined", () => {
    expect(secretsFromSettings(settings({ host: "h", password: "  pa ss  " }))?.password).toBe("  pa ss  ");
    expect(secretsFromSettings(settings({ host: "h", password: "" }))?.password).toBeUndefined();
    expect(secretsFromSettings(settings({ host: "h", password: null }))?.password).toBeUndefined();
  });
});
