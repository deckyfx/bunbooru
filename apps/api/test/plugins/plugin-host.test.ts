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
  { id: "alpha", name: "Alpha", version: "1.0.0", description: "First", capabilities: ["routes"], tables: [], adminPages: [] },
  {
    id: "beta",
    name: "Beta",
    version: "2.0.0",
    description: null,
    capabilities: [],
    tables: ["beta_widgets"],
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

  it("drives capability bindings on init, activate, and deactivate", async () => {
    const events: string[] = [];
    const binding = {
      onActivate: (p: LoadedPlugin) => events.push(`+${p.id}`),
      onDeactivate: (p: LoadedPlugin) => events.push(`-${p.id}`),
    };
    const host = createPluginHost({
      pluginState: fakeState({ alpha: true }), // alpha active at boot
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });

    await host.init();
    expect(events).toEqual(["+alpha"]); // installed for the already-active plugin

    await host.activate("beta");
    await host.deactivate("alpha");
    expect(events).toEqual(["+alpha", "+beta", "-alpha"]);
  });

  it("activate/deactivate are idempotent — bindings never re-fire on a redundant call", async () => {
    const events: string[] = [];
    const binding = {
      onActivate: (p: LoadedPlugin) => events.push(`+${p.id}`),
      onDeactivate: (p: LoadedPlugin) => events.push(`-${p.id}`),
    };
    const host = createPluginHost({
      pluginState: fakeState(),
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init();

    await host.activate("beta");
    await host.activate("beta"); // already active → no-op, must not re-install
    await host.deactivate("beta");
    await host.deactivate("beta"); // already inactive → no-op, must not re-remove
    expect(events).toEqual(["+beta", "-beta"]);
  });

  it("serializes concurrent activate calls — the capability installs exactly once", async () => {
    const events: string[] = [];
    const binding = {
      onActivate: (p: LoadedPlugin) => events.push(`+${p.id}`),
      onDeactivate: (p: LoadedPlugin) => events.push(`-${p.id}`),
    };
    const host = createPluginHost({
      pluginState: fakeState(),
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init();

    // Three racing activations must not triple-install (the idempotency check is
    // re-evaluated inside the per-plugin queue, not just before the first await).
    await Promise.all([host.activate("beta"), host.activate("beta"), host.activate("beta")]);
    expect(events).toEqual(["+beta"]);
    expect(host.isActive("beta")).toBe(true);
  });

  it("serializes concurrent deactivate calls — the capability removes exactly once", async () => {
    const events: string[] = [];
    const binding = {
      onActivate: (p: LoadedPlugin) => events.push(`+${p.id}`),
      onDeactivate: (p: LoadedPlugin) => events.push(`-${p.id}`),
    };
    const host = createPluginHost({
      pluginState: fakeState({ beta: true }),
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init(); // installs +beta
    events.length = 0;

    await Promise.all([host.deactivate("beta"), host.deactivate("beta")]);
    expect(events).toEqual(["-beta"]);
    expect(host.isActive("beta")).toBe(false);
  });

  it("a throwing onDeactivate leaves the plugin active with its capability intact", async () => {
    let installs = 0;
    const binding = {
      onActivate: () => {
        installs += 1;
      },
      onDeactivate: () => {
        throw new Error("cleanup boom");
      },
    };
    const state = fakeState({ beta: true });
    const host = createPluginHost({
      pluginState: state,
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init(); // installs === 1

    // Removal fails BEFORE persist, so nothing is half-applied: DB + memory still
    // report active and the capability is still installed. The failing binding IS
    // compensated (onActivate re-runs, installs === 2) because a hook can throw
    // *after* partially tearing its capability down — and `onActivate` is
    // contractually idempotent, so re-running one that never came off is a no-op.
    await expect(host.deactivate("beta")).rejects.toThrow("cleanup boom");
    expect(host.isActive("beta")).toBe(true);
    expect(state.rows.get("beta")).toBe(true);
    expect(installs).toBe(2);
  });

  it("runs every rollback compensation even when one throws, and aggregates the errors", async () => {
    const calls: string[] = [];
    const bindingA = {
      onActivate: () => void calls.push("A.on"),
      onDeactivate: () => {
        calls.push("A.off");
        throw new Error("A rollback boom"); // the compensation itself fails
      },
    };
    const bindingB = {
      onActivate: () => {
        calls.push("B.on");
        throw new Error("B install boom"); // triggers rollback of A
      },
      onDeactivate: () => void calls.push("B.off"),
    };
    const host = createPluginHost({
      pluginState: fakeState(),
      loaded,
      seedActiveIds: [],
      capabilityBindings: [bindingA, bindingB],
    });
    await host.init();

    const err = await host.activate("beta").catch((e: unknown) => e);
    // B is compensated too: it ran (and may have mutated state) before throwing, so
    // skipping its onDeactivate would strand a half-installed capability. Then A's
    // onDeactivate is still ATTEMPTED even though it throws; the primary + rollback
    // errors are bundled, not lost.
    expect(calls).toEqual(["A.on", "B.on", "B.off", "A.off"]);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(2);
    // Nothing was persisted → the plugin is not active.
    expect(host.isActive("beta")).toBe(false);
  });

  it("bundles the persist error with a failed rollback on activate", async () => {
    const binding = {
      onActivate: () => {},
      onDeactivate: () => {
        throw new Error("rollback boom"); // the recovery from the persist failure fails
      },
    };
    const state = fakeState();
    state.setActive = async () => {
      throw new Error("persist boom");
    };
    const host = createPluginHost({
      pluginState: state,
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init();

    const err = await host.activate("beta").catch((e: unknown) => e);
    // Without bundling, removeCapabilities' throw would REPLACE the persist error and
    // the real cause (the DB write) would be lost. Both must survive.
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "persist boom",
      "rollback boom",
    ]);
    expect(host.isActive("beta")).toBe(false);
  });

  it("bundles the persist error with a failed restore on deactivate", async () => {
    // Only fail the RESTORE — init() installs capabilities for already-active
    // plugins, so an unconditionally throwing onActivate would break setup instead.
    let armed = false;
    const binding = {
      onActivate: () => {
        if (armed) throw new Error("restore boom");
      },
      onDeactivate: () => {},
    };
    const state = fakeState({ beta: true });
    state.setActive = async () => {
      throw new Error("persist boom");
    };
    const host = createPluginHost({
      pluginState: state,
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init();
    armed = true;

    const err = await host.deactivate("beta").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "persist boom",
      "restore boom",
    ]);
    // The persist failed, so the plugin stays active in memory.
    expect(host.isActive("beta")).toBe(true);
  });

  it("compensates a hook that mutated state before throwing, on activation", async () => {
    const installed = new Set<string>();
    const binding = {
      onActivate: () => {
        installed.add("half"); // mutate…
        throw new Error("install boom"); // …then fail
      },
      onDeactivate: () => void installed.delete("half"),
    };
    const host = createPluginHost({
      pluginState: fakeState(),
      loaded,
      seedActiveIds: [],
      capabilityBindings: [binding],
    });
    await host.init();

    await expect(host.activate("beta")).rejects.toThrow("install boom");
    // The failing hook's own onDeactivate ran, so its partial mutation is gone —
    // no capability residue from a half-completed activation.
    expect(installed.size).toBe(0);
    expect(host.isActive("beta")).toBe(false);
  });

  it("compensates a hook that mutated state before throwing, on deactivation", async () => {
    const installed = new Set<string>(["cap"]);
    const binding = {
      onActivate: () => void installed.add("cap"),
      onDeactivate: () => {
        installed.delete("cap"); // half-remove…
        throw new Error("remove boom"); // …then fail
      },
    };
    const host = createPluginHost({
      pluginState: fakeState(),
      loaded,
      seedActiveIds: ["beta"],
      capabilityBindings: [binding],
    });
    await host.init();

    await expect(host.deactivate("beta")).rejects.toThrow("remove boom");
    // The failing hook's own onActivate re-ran, restoring what it had already torn
    // down — the plugin stays active WITH its capability, not half-removed.
    expect(installed.has("cap")).toBe(true);
    expect(host.isActive("beta")).toBe(true);
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
  mailService: {} as Core["mailService"],
  pluginStateService: {} as Core["pluginStateService"],
  pluginCatalogService: {} as Core["pluginCatalogService"],
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
