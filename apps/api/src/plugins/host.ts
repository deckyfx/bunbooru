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

/** Inputs for {@link createPluginHost}. */
export interface PluginHostOptions {
  /** Just the persistence slice of Core the host needs. */
  pluginState: PluginStateService;
  /** Every known plugin, already imported+migrated+registered (routes mounted separately). */
  loaded: readonly LoadedPlugin[];
  /** Env `ENABLED_PLUGINS` — seeds the DB active set on first boot only. */
  seedActiveIds: readonly string[];
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
  const { pluginState, loaded, seedActiveIds } = options;

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
      // Persist FIRST; only mirror into the in-memory set once the write lands, so
      // a failed persist can't leave memory and DB disagreeing (the route 500s and
      // the plugin stays as it was, matching what the next boot would restore).
      await pluginState.setActive(id, true);
      active.add(id);
      logger.info("plugin_activated", { id });
      return describe(p);
    },

    async deactivate(id) {
      const p = byId.get(id);
      if (!p) throw new UnknownPluginError(id);
      await pluginState.setActive(id, false);
      active.delete(id);
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
