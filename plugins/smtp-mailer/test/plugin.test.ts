import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type {
  AssetService,
  AuthService,
  CoreEvents,
  DB,
  PluginContext,
  PluginLogger,
  SettingsService,
  StatsService,
  StorageProvider,
  TagService,
} from "@bunbooru/plugin-sdk";

import { plugin } from "../src/index";

/** Recording logger to assert log-only delivery. */
function fakeLogger(): PluginLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (m) => messages.push(m),
    warn: (m) => messages.push(m),
    error: (m) => messages.push(m),
  };
}

/**
 * A stub {@link PluginContext} — enough to exercise `register`. In log-only mode
 * (no SMTP host) `register` never starts a worker and never touches the db, so a
 * bare db stub is fine.
 */
function stubContext(log: PluginLogger): PluginContext {
  return {
    services: {
      assets: {} as AssetService,
      tags: {} as TagService,
      stats: {} as StatsService,
      settings: {} as SettingsService,
      auth: {} as AuthService,
    },
    // Not used by register in log-only mode (no event subscriptions).
    events: {} as CoreEvents,
    db: {} as DB,
    storage: {} as StorageProvider,
    auth: { currentUser: async () => null },
    log,
  };
}

// Force log-only mode regardless of the developer's environment.
let savedHost: string | undefined;
beforeAll(() => {
  savedHost = Bun.env.SMTP_HOST;
  delete Bun.env.SMTP_HOST;
});
afterAll(() => {
  if (savedHost !== undefined) Bun.env.SMTP_HOST = savedHost;
});

describe("smtp-mailer plugin manifest", () => {
  it("declares a stable id, description, and the mail-providers capability", () => {
    expect(plugin.id).toBe("smtp-mailer");
    expect(plugin.description).toBeString();
    expect(plugin.capabilities).toContain("mail-providers");
  });

  it("uses a plugin-scoped migrations table", () => {
    expect(plugin.migrations?.migrationsTable).toBe("__drizzle_migrations_smtp-mailer");
    expect(plugin.migrations?.migrationsFolder).toContain("drizzle");
  });
});

describe("smtp-mailer register (log-only, over a stub context)", () => {
  it("returns routes, an admin page, and a mail provider", async () => {
    const registration = await plugin.register(stubContext(fakeLogger()));
    expect(registration.mailProvider).toBeDefined();
    expect(registration.routes).toBeDefined();
    expect(registration.adminPages).toEqual([{ id: "smtp-mailer", title: "Email (SMTP)" }]);
  });

  it("installs a provider that delivers in log-only mode (no db, no SMTP)", async () => {
    const log = fakeLogger();
    const registration = await plugin.register(stubContext(log));
    await registration.mailProvider?.send({
      to: "user@example.com",
      subject: "hi",
      text: "body",
      idempotencyKey: "plugin-test:1",
    });
    expect(log.messages).toContain("mail_log_only");
    // verify() resolves without a transport to probe.
    await expect(registration.mailProvider?.verify()).resolves.toBeUndefined();
  });
});
