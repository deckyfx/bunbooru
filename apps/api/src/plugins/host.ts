import type { PluginStateService } from "@bunbooru/core";
import type { SdkCapability } from "@bunbooru/plugin-sdk";

import { logger } from "../lib/logger";
import type { LoadedPlugin } from "./loader";

/**
 * Admin-facing description of a known plugin — everything the "Extensions"
 * management page needs to render one card, for active AND inactive plugins.
 */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  capabilities: SdkCapability[];
  /** The DB tables this plugin owns (from its `tables` declaration / the catalog). */
  tables: string[];
  /** Admin pages this plugin contributes to the console. */
  adminPages: { id: string; title: string }[];
  /** Whether the plugin is currently mounted (its routes/pages are served). */
  active: boolean;
}

/** Wire shape of `GET /api/v1/plugins` — active plugins only. */
export interface PluginManifestEntry {
  id: string;
  name: string;
  version: string;
  adminPages: { id: string; title: string }[];
}

/** Raised for an id that isn't a known first-party plugin (→ 404 at the route). */
export class UnknownPluginError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Unknown plugin: ${pluginId}`);
    this.name = "UnknownPluginError";
  }
}

/**
 * A plugin-provided capability that must be installed/removed as the plugin is
 * activated/deactivated at runtime — the general seam for anything that "comes and
 * goes" with a plugin: its mail provider today; nav items, UI slots, search/storage
 * providers, etc. later. The host applies these on {@link PluginHost.init} for
 * already-active plugins, and on every {@link PluginHost.activate}/
 * {@link PluginHost.deactivate}. Implementations MUST be idempotent.
 *
 * (Plugin ROUTES and admin pages already come-and-go via the active-set gate + the
 * manifest, so they don't need a binding — this is for capabilities Core or the app
 * holds a live reference to.)
 */
export interface PluginCapabilityBinding {
  /** Install the capability the now-active `plugin` provides (no-op if it has none). */
  onActivate(plugin: LoadedPlugin): void;
  /** Remove the capability the now-inactive `plugin` provided (no-op if it has none). */
  onDeactivate(plugin: LoadedPlugin): void;
}

/** Inputs for {@link createPluginHost}. */
export interface PluginHostOptions {
  /** Just the persistence slice of Core the host needs. */
  pluginState: PluginStateService;
  /** Every known plugin, already imported+migrated+registered (routes mounted separately). */
  loaded: readonly LoadedPlugin[];
  /** Env `ENABLED_PLUGINS` — seeds the DB active set on first boot only. */
  seedActiveIds: readonly string[];
  /**
   * Capabilities that follow a plugin's active state (see
   * {@link PluginCapabilityBinding}). Applied to already-active plugins on init()
   * and on every activate()/deactivate(). Defaults to none.
   */
  capabilityBindings?: readonly PluginCapabilityBinding[];
}

/**
 * Runtime owner of which first-party plugins are active. All known plugins are
 * loaded and mounted at boot (so their routes inherit the root app's auth/error
 * handling); this host gates them: an inactive plugin's routes 404 (via the
 * `onRequest` gate in the server) and it drops out of the manifest — with no
 * process restart. Backed by `core.pluginStateService` for persistence.
 *
 * NOTE: deactivating hides a plugin's routes and pages immediately, but any
 * background work it started at boot (event listeners, jobs) keeps running until
 * the next restart — surfaced to admins in the management UI.
 */
export interface PluginHost {
  /** Seed the active set (first boot only) then load it into memory. */
  init(): Promise<void>;
  /** Whether `id` is currently active (hot-path gate check). */
  isActive(id: string): boolean;
  /** Manifest for `GET /api/v1/plugins` — active plugins only. */
  manifest(): PluginManifestEntry[];
  /** Every known plugin with metadata + current state, for the management page. */
  describeAll(): ExtensionInfo[];
  /** Activate `id` and persist. Throws {@link UnknownPluginError} for an unknown id. */
  activate(id: string): Promise<ExtensionInfo>;
  /** Deactivate `id` and persist. Throws {@link UnknownPluginError} for an unknown id. */
  deactivate(id: string): Promise<ExtensionInfo>;
}

/** Build the runtime {@link PluginHost}. */
export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { pluginState, loaded, seedActiveIds, capabilityBindings = [] } = options;

  const byId = new Map<string, LoadedPlugin>(loaded.map((p) => [p.id, p]));
  /** In-memory mirror of the persisted active set (hot-path lookups + gating). */
  const active = new Set<string>();

  function describe(p: LoadedPlugin): ExtensionInfo {
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      capabilities: [...p.capabilities],
      tables: [...p.tables],
      adminPages: p.adminPages,
      active: active.has(p.id),
    };
  }

  return {
    async init() {
      await pluginState.seedIfEmpty(seedActiveIds);
      const persisted = await pluginState.activeIds();
      for (const id of persisted) {
        if (byId.has(id)) active.add(id);
        // A persisted id whose plugin failed to load (or was removed) is ignored
        // — the loader already logged the load failure.
        else logger.warn("plugin_state_unmounted_id", { id });
      }
      // Install the capabilities of every already-active plugin (e.g. its mail
      // provider), so boot reflects the persisted active set.
      for (const id of active) {
        const p = byId.get(id);
        if (p) for (const binding of capabilityBindings) binding.onActivate(p);
      }
    },

    isActive(id) {
      return active.has(id);
    },

    manifest() {
      const out: PluginManifestEntry[] = [];
      for (const p of loaded) {
        if (active.has(p.id)) {
          out.push({ id: p.id, name: p.name, version: p.version, adminPages: p.adminPages });
        }
      }
      return out;
    },

    describeAll() {
      return loaded.map(describe).sort((a, b) => a.name.localeCompare(b.name));
    },

    async activate(id) {
      const p = byId.get(id);
      if (!p) throw new UnknownPluginError(id);
      // Install the plugin's capabilities FIRST, so a failure here (e.g. a mail
      // provider conflict) aborts with NO persisted or in-memory change — the
      // plugin stays exactly as it was. Roll back the ones already installed if a
      // later binding throws mid-list.
      const installed: PluginCapabilityBinding[] = [];
      try {
        for (const binding of capabilityBindings) {
          binding.onActivate(p);
          installed.push(binding);
        }
      } catch (error) {
        for (const binding of installed.reverse()) binding.onDeactivate(p);
        throw error;
      }
      // Persist, THEN mirror into the in-memory set. If the write fails, undo the
      // capability installs too, so DB, memory, and capability state can never
      // disagree (the route 500s and the plugin stays as the next boot would find it).
      try {
        await pluginState.setActive(id, true);
      } catch (error) {
        for (const binding of capabilityBindings) binding.onDeactivate(p);
        throw error;
      }
      active.add(id);
      logger.info("plugin_activated", { id });
      return describe(p);
    },

    async deactivate(id) {
      const p = byId.get(id);
      if (!p) throw new UnknownPluginError(id);
      await pluginState.setActive(id, false);
      active.delete(id);
      for (const binding of capabilityBindings) binding.onDeactivate(p);
      logger.info("plugin_deactivated", { id });
      return describe(p);
    },
  };
}

/**
 * A permissive stand-in host for `createApp` callers that mount plugin routes
 * directly (tests) or run no plugins. Nothing is gated (`isActive` → true), the
 * manifest echoes any statically-provided entries, and toggling is unsupported.
 */
export function staticPluginHost(manifest: readonly PluginManifestEntry[] = []): PluginHost {
  const entries = [...manifest];
  return {
    init: async () => {},
    isActive: () => true,
    manifest: () => entries,
    describeAll: () =>
      entries.map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        description: null,
        capabilities: [],
        tables: [],
        adminPages: e.adminPages,
        active: true,
      })),
    activate: async (id) => {
      throw new UnknownPluginError(id);
    },
    deactivate: async (id) => {
      throw new UnknownPluginError(id);
    },
  };
}
