import { describe, expect, it } from "bun:test";

import type {
  AssetService,
  AuthService,
  Core,
  DB,
  SettingsService,
  StatsService,
  TagService,
} from "@bunbooru/core";
import { createCoreEvents } from "@bunbooru/core";
import { buildExampleRoutes } from "@bunbooru/plugin-example";
import type { PluginContext } from "@bunbooru/plugin-sdk";

import { createApp } from "../../src/server";

/** Minimal Core for `createApp`: the two requests below carry no auth header, so
 *  the per-request `currentUser` lookup never fires and these casts are never hit. */
const appCore = {
  assetService: {} as AssetService,
  uploadService: {} as Core["uploadService"],
  tagService: {} as TagService,
  statsService: {} as StatsService,
  authService: {} as AuthService,
  settingsService: {} as SettingsService,
  events: createCoreEvents(),
} satisfies Core;

/** A plugin context whose stats report a fixed post count and whose auth is
 *  always anonymous — enough to exercise `/ping` and the write's 401 gate. */
const anonContext: PluginContext = {
  services: {
    assets: {} as AssetService,
    tags: {} as TagService,
    stats: {
      recordView: async () => true,
      recordVisit: async () => undefined,
      getStats: async () => ({ posts: 5, visitorsToday: 0 }),
    },
    settings: {} as SettingsService,
    auth: {} as AuthService,
  },
  events: createCoreEvents(),
  db: {} as DB,
  auth: { currentUser: async () => null },
  log: { info: () => {}, warn: () => {}, error: () => {} },
};

/** The app with the example plugin's routes mounted (as the composition root does). */
function appWithExample(ctx: PluginContext = anonContext) {
  const app = createApp({ core: appCore });
  app.use(buildExampleRoutes(ctx));
  return app;
}

describe("example plugin routes", () => {
  it("GET /api/v1/plugins/example/ping reports Core data (post count)", async () => {
    const app = appWithExample();
    const res = await app.handle(
      new Request("http://localhost/api/v1/plugins/example/ping"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true, posts: 5 });
  });

  it("POST /api/v1/plugins/example/pings is 401 for an anonymous caller", async () => {
    const app = appWithExample();
    const res = await app.handle(
      new Request("http://localhost/api/v1/plugins/example/pings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "hello" }),
      }),
    );
    // AuthenticationError thrown in the plugin route maps to 401 via the root
    // app's shared onError — proving mounted plugin routes inherit it.
    expect(res.status).toBe(401);
  });
});

describe("plugin manifest", () => {
  it("GET /api/v1/plugins is empty when no plugins are provided", async () => {
    const res = await createApp({ core: appCore }).handle(
      new Request("http://localhost/api/v1/plugins"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /api/v1/plugins lists provided plugin metadata", async () => {
    const app = createApp({
      core: appCore,
      plugins: [
        { id: "example", name: "Example", version: "0.1.0", adminPages: [{ id: "pings", title: "Example: Pings" }] },
      ],
    });
    const res = await app.handle(new Request("http://localhost/api/v1/plugins"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "example", name: "Example", version: "0.1.0", adminPages: [{ id: "pings", title: "Example: Pings" }] },
    ]);
  });
});
