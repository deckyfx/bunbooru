import { applyMigrations, type Core, type DB, type StorageProvider } from "@bunbooru/core";
import type {
  AdminPage,
  BunbooruPlugin,
  PluginContext,
  PluginRegistration,
  SdkCapability,
} from "@bunbooru/plugin-sdk";
import type { AnyElysia } from "elysia";

import { readSessionToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { namespacedStorage } from "./namespaced-storage";
import { PLUGIN_REGISTRY, type PluginModule } from "./registry";

/** A successfully-loaded plugin: its manifest metadata + mounted routes. */
export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  /** One-line summary for the admin management UI (null if the plugin omits it). */
  description: string | null;
  /** SDK capabilities the plugin declares (badges in the management UI). */
  capabilities: SdkCapability[];
  adminPages: AdminPage[];
  /** The plugin's Elysia app (prefixed by `pluginRoutePrefix`), if it has routes. */
  routes?: AnyElysia;
}

/** Default per-step timeout (ms) — see {@link LoadPluginsOptions.stepTimeoutMs}. */
export const DEFAULT_PLUGIN_STEP_TIMEOUT_MS = 30_000;

/** Inputs the loader wires each plugin over. */
export interface LoadPluginsOptions {
  /** Assembled Core services, exposed to plugins via `ctx.services`. */
  core: Core;
  /** Shared DB handle for plugin migrations + `ctx.db`. */
  db: DB;
  /** Shared asset storage — each plugin gets a `plugins/<id>/`-namespaced view. */
  storage: StorageProvider;
  /** Plugin ids to load (from `ENABLED_PLUGINS`). */
  enabledIds: string[];
  /** Registry of known plugins (injectable for tests; defaults to the real one). */
  registry?: Record<string, () => Promise<PluginModule>>;
  /**
   * Max time (ms) each awaited step (import / migrate / register) may take before
   * it's abandoned. A step that HANGS (rather than throws) would otherwise stall
   * `loadPlugins` forever — and since the composition root awaits it before the
   * server starts, one hung plugin would block the whole API from coming up.
   * Injectable so tests can exercise the timeout quickly. Default
   * {@link DEFAULT_PLUGIN_STEP_TIMEOUT_MS}.
   */
  stepTimeoutMs?: number;
}

/**
 * Short, safe error text for logs. `String(error)` itself can throw (e.g. a
 * null-prototype object, or one whose `toString` throws) — and this runs INSIDE
 * the loader's catch blocks, so an unguarded throw here would escape
 * `loadPlugins` and break the failure isolation it exists to provide. Fall back
 * to a fixed message instead.
 */
function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}

/**
 * Race `promise` against a timer so a hung step can't stall startup. On timeout
 * it rejects (handled by the caller's existing try/catch → log + skip that
 * plugin). The underlying promise isn't cancelable (JS can't), but it's
 * abandoned — the loader moves on. The timer is always cleared so a settled race
 * never keeps the process alive.
 */
function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Assemble the {@link PluginContext} the host injects into a plugin. */
function buildContext(id: string, core: Core, db: DB, storage: StorageProvider): PluginContext {
  return {
    services: {
      assets: core.assetService,
      tags: core.tagService,
      stats: core.statsService,
      settings: core.settingsService,
      auth: core.authService,
    },
    events: core.events,
    db,
    // Namespaced to `plugins/<id>/` so a plugin can't touch Core or peer keys.
    storage: namespacedStorage(storage, `plugins/${id}`),
    auth: {
      // Resolve the caller the same way the core routes do (Bearer or cookie),
      // so a plugin route's auth is consistent with the rest of the API.
      currentUser: (request) => {
        const token = readSessionToken(request);
        return token ? core.authService.currentUser(token) : Promise.resolve(null);
      },
    },
    log: {
      info: (message, data) => logger.info(`plugin:${id} ${message}`, data),
      warn: (message, data) => logger.warn(`plugin:${id} ${message}`, data),
      error: (message, data) => logger.error(`plugin:${id} ${message}`, data),
    },
  };
}

/**
 * Load the enabled plugins: for each id, import it, apply its migrations, then
 * call `register` with a live {@link PluginContext}.
 *
 * Every failure mode is isolated and logged so one bad plugin never takes down
 * the API: an unknown id, an id/module mismatch, a failed import, a failed
 * migration (the plugin is skipped rather than mounted over missing tables), or
 * a throwing `register`. Order within a plugin is fixed — migrations run BEFORE
 * `register`, so a plugin's tables exist by the time its routes do.
 */
export async function loadPlugins({
  core,
  db,
  storage,
  enabledIds,
  registry = PLUGIN_REGISTRY,
  stepTimeoutMs = DEFAULT_PLUGIN_STEP_TIMEOUT_MS,
}: LoadPluginsOptions): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];

  for (const id of enabledIds) {
    // `Object.hasOwn` (not `registry[id]` truthiness): an id like "constructor"
    // or "toString" would otherwise resolve to an inherited Object.prototype
    // member and bypass the unknown-plugin check.
    const importer = Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (!importer) {
      logger.warn("plugin_unknown", { id });
      continue;
    }

    let plugin: BunbooruPlugin;
    try {
      ({ plugin } = await withTimeout(importer(), `plugin ${id} import`, stepTimeoutMs));
    } catch (error) {
      logger.error("plugin_import_failed", { id, error: errorMessage(error) });
      continue;
    }

    // Guard the registry key against the plugin's own id so a route prefix /
    // migration table can never silently diverge from the enabled id.
    if (plugin.id !== id) {
      logger.error("plugin_id_mismatch", { registryId: id, pluginId: plugin.id });
      continue;
    }

    if (plugin.migrations) {
      try {
        await withTimeout(
          applyMigrations(db, plugin.migrations),
          `plugin ${id} migration`,
          stepTimeoutMs,
        );
        logger.info("plugin_migrated", { id });
      } catch (error) {
        // A plugin whose tables didn't migrate must NOT be mounted — its routes
        // would hit missing tables. Skip it (loudly) but keep the API up.
        logger.error("plugin_migration_failed", { id, error: errorMessage(error) });
        continue;
      }
    }

    let registration: PluginRegistration;
    try {
      registration = await withTimeout(
        Promise.resolve(plugin.register(buildContext(id, core, db, storage))),
        `plugin ${id} register`,
        stepTimeoutMs,
      );
    } catch (error) {
      logger.error("plugin_register_failed", { id, error: errorMessage(error) });
      continue;
    }

    loaded.push({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description ?? null,
      capabilities: [...(plugin.capabilities ?? [])],
      adminPages: registration.adminPages ?? [],
      routes: registration.routes,
    });
    logger.info("plugin_loaded", {
      id,
      hasRoutes: registration.routes !== undefined,
      adminPages: (registration.adminPages ?? []).length,
    });
  }

  return loaded;
}
