import { describe, expect, it } from "bun:test";

import type {
  AssetService,
  AuthService,
  Core,
  PluginStateService,
  SettingsService,
  StatsService,
  TagService,
} from "@bunbooru/core";
import { createCoreEvents } from "@bunbooru/core";
import { Elysia } from "elysia";

import { createPluginHost, UnknownPluginError } from "../../src/plugins/host";
import type { LoadedPlugin } from "../../src/plugins/loader";
import { createApp } from "../../src/server";

/** In-memory {@link PluginStateService} tracking an active set. */
function fakeState(initial: Record<string, boolean> = {}): PluginStateService & {
  rows: Map<string, boolean>;
} {
  const rows = new Map<string, boolean>(Object.entries(initial));
  return {
    rows,
    activeIds: async () =>
      new Set([...rows].filter(([, active]) => active).map(([id]) => id)),
    setActive: async (id, active) => {
      rows.set(id, active);
    },
    seedIfEmpty: async (ids) => {
      if (rows.size > 0) return false;
      for (const id of ids) rows.set(id, true);
      return true;
    },
  };
}

/** A tiny plugin Elysia app mounted under its `/api/v1/plugins/<id>` prefix. */
function betaRoutes() {
  return new Elysia({ prefix: "/api/v1/plugins/beta" }).get("/ping", () => ({ ok: true }));
}

const loaded: LoadedPlugin[] = [
  { id: "alpha", name: "Alpha", version: "1.0.0", description: "First", capabilities: ["routes"], adminPages: [] },
  {
    id: "beta",
    name: "Beta",
    version: "2.0.0",
    description: null,
    capabilities: [],
    adminPages: [{ id: "x", title: "X" }],
    routes: betaRoutes(),
  },
];

describe("createPluginHost", () => {
  it("seeds the active set from env on first boot, then loads it", async () => {
    const host = createPluginHost({
      pluginState: fakeState(),
      loaded,
      seedActiveIds: ["alpha"],
    });
    await host.init();
    expect(host.isActive("alpha")).toBe(true);
    expect(host.isActive("beta")).toBe(false);
    expect(host.manifest().map((p) => p.id)).toEqual(["alpha"]);
  });

  it("reads a persisted set and ignores the env seed once rows exist", async () => {
    const host = createPluginHost({
      pluginState: fakeState({ alpha: false, beta: true }),
      loaded,
      seedActiveIds: ["alpha"], // must NOT re-enable alpha
    });
    await host.init();
    expect(host.isActive("alpha")).toBe(false);
    expect(host.isActive("beta")).toBe(true);
  });

  it("describeAll lists every known plugin (sorted) with metadata + state", async () => {
    const host = createPluginHost({ pluginState: fakeState({ alpha: true }), loaded, seedActiveIds: [] });
    await host.init();
    const all = host.describeAll();
    expect(all.map((e) => e.id)).toEqual(["alpha", "beta"]); // sorted by name
    const beta = all.find((e) => e.id === "beta")!;
    expect(beta.active).toBe(false);
    expect(beta.adminPages).toEqual([{ id: "x", title: "X" }]);
  });

  it("activate/deactivate flip state, persist, and update the manifest", async () => {
    const state = fakeState();
    const host = createPluginHost({ pluginState: state, loaded, seedActiveIds: [] });
    await host.init();

    await host.activate("beta");
    expect(host.isActive("beta")).toBe(true);
    expect(state.rows.get("beta")).toBe(true);
    expect(host.manifest().map((p) => p.id)).toContain("beta");

    await host.deactivate("beta");
    expect(host.isActive("beta")).toBe(false);
    expect(state.rows.get("beta")).toBe(false);
    expect(host.manifest()).toEqual([]);
  });

  it("throws UnknownPluginError for an id that isn't a known plugin", async () => {
    const host = createPluginHost({ pluginState: fakeState(), loaded, seedActiveIds: [] });
    await host.init();
    await expect(host.activate("nope")).rejects.toBeInstanceOf(UnknownPluginError);
    await expect(host.deactivate("nope")).rejects.toBeInstanceOf(UnknownPluginError);
  });
});

/** Minimal Core for `createApp` — the requests below carry no auth, so the
 *  per-request currentUser lookup never fires and these casts are never hit. */
const appCore = {
  assetService: {} as AssetService,
  uploadService: {} as Core["uploadService"],
  tagService: {} as TagService,
  statsService: {} as StatsService,
  authService: {} as AuthService,
  settingsService: {} as SettingsService,
  pluginStateService: {} as Core["pluginStateService"],
  events: createCoreEvents(),
} satisfies Core;

describe("plugin route gate (onRequest)", () => {
  it("404s an inactive plugin's routes, then serves them once activated", async () => {
    const host = createPluginHost({ pluginState: fakeState(), loaded, seedActiveIds: [] });
    await host.init(); // beta inactive
    const app = createApp({ core: appCore, host });
    app.use(betaRoutes());

    const gated = await app.handle(new Request("http://localhost/api/v1/plugins/beta/ping"));
    expect(gated.status).toBe(404);

    await host.activate("beta");
    const served = await app.handle(new Request("http://localhost/api/v1/plugins/beta/ping"));
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ ok: true });
  });

  it("GET /api/v1/plugins reflects the active manifest", async () => {
    const host = createPluginHost({ pluginState: fakeState({ alpha: true }), loaded, seedActiveIds: [] });
    await host.init();
    const app = createApp({ core: appCore, host });
    const res = await app.handle(new Request("http://localhost/api/v1/plugins"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((p) => p.id)).toEqual(["alpha"]);
  });
});
