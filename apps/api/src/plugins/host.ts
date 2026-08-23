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

/**
 * Best-effort, reverse-order rollback after a partial capability transition. `done`
 * holds every binding whose hook was ATTEMPTED (the failing one included, since it
 * may have mutated state before throwing). Runs `undo` for EVERY binding in `done`
 * even if some throw (a failing compensation
 * must not strand the rest), then returns the primary error alone when rollback
 * was clean, or an {@link AggregateError} bundling the primary + every rollback
 * failure when it wasn't — a genuine inconsistent-state alarm the caller surfaces
 * (a 500) rather than swallowing. `done` is consumed (reversed) in place.
 */
function compensate(
  primary: unknown,
  done: PluginCapabilityBinding[],
  undo: (binding: PluginCapabilityBinding) => void,
): unknown {
  const rollbackErrors: unknown[] = [];
  for (const binding of done.reverse()) {
    try {
      undo(binding);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  if (rollbackErrors.length === 0) return primary;
  return new AggregateError(
    [primary, ...rollbackErrors],
    "plugin capability transition failed AND its rollback failed — capability state may be inconsistent",
  );
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

  /**
   * Per-plugin transition queue. `activate`/`deactivate` for a given id run one at
   * a time, so two concurrent calls can't both clear the idempotency check and
   * double-apply (double install / double cleanup). Chaining after the previous
   * transition SETTLES (success or failure) means a failed transition never wedges
   * the queue; the stored tail never rejects so the next enqueue can await it.
   */
  const transitions = new Map<string, Promise<unknown>>();
  function serialize<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prev = transitions.get(id) ?? Promise.resolve();
    const run = prev.then(op, op);
    transitions.set(
      id,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /** Install every binding's capability for `p`; on any throw, best-effort remove
   *  every binding ATTEMPTED — including the one that threw — before rethrowing, so a
   *  hook that mutates state and only then fails can't strand it. Never a partial
   *  install. */
  function installCapabilities(p: LoadedPlugin): void {
    const done: PluginCapabilityBinding[] = [];
    try {
      for (const binding of capabilityBindings) {
        // Record BEFORE invoking: a hook may mutate state and THEN throw, and that
        // half-installed capability still needs compensating. `onDeactivate` is
        // contractually idempotent and a no-op when nothing was installed, so
        // compensating a hook that failed before touching anything is harmless.
        done.push(binding);
        binding.onActivate(p);
      }
    } catch (error) {
      throw compensate(error, done, (binding) => binding.onDeactivate(p));
    }
  }

  /** Remove every binding's capability for `p`; on any throw, best-effort re-install
   *  every binding ATTEMPTED — including the one that threw — before rethrowing, so a
   *  hook that half-removes its capability and only then fails can't strand it. Never
   *  a partial removal. */
  function removeCapabilities(p: LoadedPlugin): void {
    const done: PluginCapabilityBinding[] = [];
    try {
      for (const binding of capabilityBindings) {
        // Record BEFORE invoking — see the note in installCapabilities. `onActivate`
        // is likewise idempotent, so re-installing a hook that never got as far as
        // removing anything is a no-op.
        done.push(binding);
        binding.onDeactivate(p);
      }
    } catch (error) {
      throw compensate(error, done, (binding) => binding.onActivate(p));
    }
  }

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
      // provider), so boot reflects the persisted active set. A binding throwing
      // here fails the boot (fail-fast), with its own plugin's partial install
      // rolled back first.
      for (const id of active) {
        const p = byId.get(id);
        if (p) installCapabilities(p);
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
      // Serialize per-plugin so concurrent calls can't both pass the idempotency
      // check and double-apply; the check is re-evaluated INSIDE the queued op.
      return serialize(id, async () => {
        // Idempotent (the admin route documents it so): a redundant activate is a
        // no-op — never re-runs installs (which a later persist failure would then
        // wrongly roll back on an already-active plugin).
        if (active.has(id)) return describe(p);
        // Install capabilities FIRST, so a failure (e.g. a mail provider conflict)
        // aborts with NO persisted or in-memory change — the plugin stays as it was.
        installCapabilities(p);
        // Persist, THEN mirror into memory. If the write fails, undo the installs so
        // DB, memory, and capability state agree (route 500s; the plugin stays exactly
        // as the next boot would restore it). If that undo ALSO fails, the two can no
        // longer be reconciled here — surface both errors together rather than letting
        // the recovery's throw silently replace the persistence failure.
        try {
          await pluginState.setActive(id, true);
        } catch (error) {
          try {
            removeCapabilities(p);
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              `plugin "${id}" failed to persist activation AND its capability rollback failed — capability state may be inconsistent`,
            );
          }
          throw error;
        }
        active.add(id);
        logger.info("plugin_activated", { id });
        return describe(p);
      });
    },

    async deactivate(id) {
      const p = byId.get(id);
      if (!p) throw new UnknownPluginError(id);
      return serialize(id, async () => {
        // Idempotent, symmetric with activate(): a redundant deactivate is a no-op.
        if (!active.has(id)) return describe(p);
        // Remove capabilities FIRST (with rollback), so a throwing onDeactivate
        // leaves the plugin FULLY active rather than persisted-inactive-but-still-
        // installed. Only after a clean removal do we persist + drop the memory bit.
        removeCapabilities(p);
        try {
          await pluginState.setActive(id, false);
        } catch (error) {
          // Persist failed: re-install so the still-active plugin keeps its capability.
          // If the re-install ALSO fails, both errors travel together — see activate().
          try {
            installCapabilities(p);
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              `plugin "${id}" failed to persist deactivation AND its capability restore failed — capability state may be inconsistent`,
            );
          }
          throw error;
        }
        active.delete(id);
        logger.info("plugin_deactivated", { id });
        return describe(p);
      });
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
