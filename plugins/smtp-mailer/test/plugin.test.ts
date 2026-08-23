import { describe, expect, it } from "bun:test";

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
 * A read-only db stub whose SELECT chain always returns no rows — so
 * `getMailSettings` falls back to defaults (no host → log-only) and the drain
 * loop finds nothing. No host means the provider never INSERTs, so this is enough
 * to exercise `register` + log-only delivery without a real database.
 */
function stubDb(): DB {
  const chain = { from: () => chain, where: () => chain, limit: async () => [] as unknown[] };
  return { select: () => chain } as unknown as DB;
}

/** A stub {@link PluginContext} — enough to exercise `register` in log-only mode. */
function stubContext(log: PluginLogger): PluginContext {
  return {
    services: {
      assets: {} as AssetService,
      tags: {} as TagService,
      stats: {} as StatsService,
      settings: {} as SettingsService,
      auth: {} as AuthService,
    },
    events: {} as CoreEvents,
    db: stubDb(),
    storage: {} as StorageProvider,
    auth: { currentUser: async () => null },
    log,
  };
}

describe("smtp-mailer plugin manifest", () => {
  it("declares a stable id, description, and the mail-providers capability", () => {
    expect(plugin.id).toBe("smtp-mailer");
    expect(plugin.description).toBeString();
    expect(plugin.capabilities).toContain("mail-providers");
  });

  it("uses a plugin-scoped migrations table and embeds its SQL", () => {
    expect(plugin.migrations?.migrationsTable).toBe("__drizzle_migrations_smtp-mailer");
    // Migrations are embedded (compiled into the binary), not read from disk.
    expect(typeof plugin.migrations?.embedded.journal).toBe("string");
    expect(Object.keys(plugin.migrations?.embedded.files ?? {}).length).toBeGreaterThan(0);
  });
});

describe("smtp-mailer register (log-only, over a stub context)", () => {
  it("returns routes, an admin page, and a mail provider", async () => {
    const registration = await plugin.register(stubContext(fakeLogger()));
    expect(registration.mailProvider).toBeDefined();
    expect(registration.routes).toBeDefined();
    expect(registration.adminPages).toEqual([{ id: "smtp-mailer", title: "Email (SMTP)" }]);
  });

  it("installs a provider that delivers in log-only mode (no SMTP host configured)", async () => {
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
