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
} from "@bunbooru/core";
import { createCoreEvents } from "@bunbooru/core";
import { definePlugin, pluginRoutePrefix, type BunbooruPlugin } from "@bunbooru/plugin-sdk";
import { Elysia } from "elysia";

import { loadPlugins } from "../../src/plugins/loader";
import type { PluginModule } from "../../src/plugins/registry";

/** A Core stub — the loader only passes these into the plugin context; the fake
 *  plugins below never call them, so empty service objects suffice. */
const core: Core = {
  assetService: {} as AssetService,
  uploadService: {} as Core["uploadService"],
  tagService: {} as TagService,
  statsService: {} as StatsService,
  authService: {} as AuthService,
  settingsService: {} as SettingsService,
  events: createCoreEvents(),
};

/** No migrations are declared, so the db handle is never touched. */
const db = {} as DB;

/** The fake plugins don't use storage, so a dummy provider suffices. */
const storage = {} as StorageProvider;

/** A well-formed plugin that registers routes + an admin page. */
function demoPlugin(id = "demo"): BunbooruPlugin {
  return definePlugin({
    id,
    name: "Demo",
    version: "1.0.0",
    register() {
      return {
        routes: new Elysia({ prefix: pluginRoutePrefix("demo") }).get("/hi", () => "hi"),
        adminPages: [{ id: "main", title: "Demo" }],
      };
    },
  });
}

/** Build a one-plugin registry from a module factory. */
function registryOf(id: string, factory: () => Promise<PluginModule>) {
  return { [id]: factory };
}

describe("loadPlugins", () => {
  it("loads an enabled, known plugin with its metadata + routes", async () => {
    const registry = registryOf("demo", async () => ({ plugin: demoPlugin() }));
    const loaded = await loadPlugins({ core, db, storage, enabledIds: ["demo"], registry });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("demo");
    expect(loaded[0]?.name).toBe("Demo");
    expect(loaded[0]?.adminPages).toEqual([{ id: "main", title: "Demo" }]);
    expect(loaded[0]?.routes).toBeDefined();
  });

  it("loads nothing when no plugins are enabled", async () => {
    const registry = registryOf("demo", async () => ({ plugin: demoPlugin() }));
    const loaded = await loadPlugins({ core, db, storage, enabledIds: [], registry });
    expect(loaded).toHaveLength(0);
  });

  it("skips an enabled id that isn't in the registry", async () => {
    const registry = registryOf("demo", async () => ({ plugin: demoPlugin() }));
    const loaded = await loadPlugins({ core, db, storage, enabledIds: ["nope"], registry });
    expect(loaded).toHaveLength(0);
  });

  it("skips a plugin whose id doesn't match its registry key", async () => {
    // Registered under "demo" but the module's plugin.id is "other" — a mismatch
    // that could silently diverge the route prefix / migrations table.
    const registry = registryOf("demo", async () => ({ plugin: demoPlugin("other") }));
    const loaded = await loadPlugins({ core, db, storage, enabledIds: ["demo"], registry });
    expect(loaded).toHaveLength(0);
  });

  it("isolates a failing import — other plugins still load", async () => {
    const registry = {
      broken: async (): Promise<PluginModule> => {
        throw new Error("boom");
      },
      demo: async (): Promise<PluginModule> => ({ plugin: demoPlugin() }),
    };
    const loaded = await loadPlugins({ core, db, storage, enabledIds: ["broken", "demo"], registry });
    expect(loaded.map((p) => p.id)).toEqual(["demo"]);
  });

  it("isolates a throwing register() — the plugin is skipped, not fatal", async () => {
    const throwing = definePlugin({
      id: "throws",
      name: "Throws",
      version: "1.0.0",
      register() {
        throw new Error("register boom");
      },
    });
    const registry = registryOf("throws", async () => ({ plugin: throwing }));
    const loaded = await loadPlugins({ core, db, storage, enabledIds: ["throws"], registry });
    expect(loaded).toHaveLength(0);
  });

  it("isolates a plugin that throws a non-stringifiable value", async () => {
    // A null-prototype value has no toString, so `String(value)` throws. If the
    // loader's error formatting weren't guarded, that throw would escape the
    // catch block and abort loadPlugins — taking down healthy plugins too.
    const hostile = definePlugin({
      id: "hostile",
      name: "Hostile",
      version: "1.0.0",
      register(): never {
        throw Object.create(null) as never;
      },
    });
    const registry = {
      hostile: async (): Promise<PluginModule> => ({ plugin: hostile }),
      demo: async (): Promise<PluginModule> => ({ plugin: demoPlugin() }),
    };
    const loaded = await loadPlugins({ core, db, storage, enabledIds: ["hostile", "demo"], registry });
    expect(loaded.map((p) => p.id)).toEqual(["demo"]);
  });

  it("times out a hanging register() so it can't stall startup", async () => {
    // register never resolves — without the per-step timeout, loadPlugins (which
    // the composition root awaits before listen) would hang the whole API.
    const hanging = definePlugin({
      id: "hangs",
      name: "Hangs",
      version: "1.0.0",
      register() {
        return new Promise<never>(() => {});
      },
    });
    const registry = {
      hangs: async (): Promise<PluginModule> => ({ plugin: hanging }),
      demo: async (): Promise<PluginModule> => ({ plugin: demoPlugin() }),
    };
    const loaded = await loadPlugins({
      core,
      db,
      storage,
      enabledIds: ["hangs", "demo"],
      registry,
      stepTimeoutMs: 20,
    });
    // The hung plugin is abandoned; the healthy one still loads.
    expect(loaded.map((p) => p.id)).toEqual(["demo"]);
  });
});
