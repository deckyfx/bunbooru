import { describe, expect, it } from "bun:test";

import type {
  AssetService,
  AuthService,
  Core,
  DB,
  SettingsService,
  StatsService,
  StorageProvider,
  TagService,
  User,
} from "@bunbooru/core";
import { createCoreEvents } from "@bunbooru/core";
import { buildThumbnailerRoutes } from "@bunbooru/plugin-thumbnailer";
import type { PluginContext } from "@bunbooru/plugin-sdk";

import { createApp } from "../../src/server";

/** Minimal Core for `createApp` — the plugin routes carry their own auth, and the
 *  requests below never set a session, so the group's `currentUser` lookup is a no-op. */
const appCore = {
  assetService: {} as AssetService,
  uploadService: {} as Core["uploadService"],
  tagService: {} as TagService,
  statsService: {} as StatsService,
  authService: {} as AuthService,
  settingsService: {} as SettingsService,
  events: createCoreEvents(),
} satisfies Core;

const member: User = {
  id: 2,
  username: "member",
  email: null,
  passwordHash: "x",
  role: "member",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** A plugin context whose auth resolves to `user` (or anonymous). db/storage are
 *  unused by the admin-gate paths under test (auth is checked first). */
function contextAs(user: User | null): PluginContext {
  return {
    services: {
      assets: {} as AssetService,
      tags: {} as TagService,
      stats: {} as StatsService,
      settings: {} as SettingsService,
      auth: {} as AuthService,
    },
    events: createCoreEvents(),
    db: {} as DB,
    storage: {} as StorageProvider,
    auth: { currentUser: async () => user },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function appAs(user: User | null) {
  const app = createApp({ core: appCore });
  app.use(buildThumbnailerRoutes(contextAs(user)));
  return app;
}

const STATUS = "http://localhost/api/v1/plugins/thumbnailer/status";
const BACKFILL = "http://localhost/api/v1/plugins/thumbnailer/backfill";

describe("thumbnailer admin routes", () => {
  it("GET /status is 401 for an anonymous caller", async () => {
    const res = await appAs(null).handle(new Request(STATUS));
    expect(res.status).toBe(401);
  });

  it("GET /status is 403 for a non-admin", async () => {
    const res = await appAs(member).handle(new Request(STATUS));
    expect(res.status).toBe(403);
  });

  it("POST /backfill is 401 for an anonymous caller", async () => {
    const res = await appAs(null).handle(new Request(BACKFILL, { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("POST /backfill is 403 for a non-admin", async () => {
    const res = await appAs(member).handle(new Request(BACKFILL, { method: "POST" }));
    expect(res.status).toBe(403);
  });
});
