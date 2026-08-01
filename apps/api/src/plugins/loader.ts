import { applyMigrations, type Core, type DB } from "@bunbooru/core";
import type {
  AdminPage,
  BunbooruPlugin,
  PluginContext,
  PluginRegistration,
} from "@bunbooru/plugin-sdk";
import type { AnyElysia } from "elysia";

import { readSessionToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { PLUGIN_REGISTRY, type PluginModule } from "./registry";

/** A successfully-loaded plugin: its manifest metadata + mounted routes. */
export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  adminPages: AdminPage[];
  /** The plugin's Elysia app (prefixed by `pluginRoutePrefix`), if it has routes. */
  routes?: AnyElysia;
}

/** Inputs the loader wires each plugin over. */
export interface LoadPluginsOptions {
  /** Assembled Core services, exposed to plugins via `ctx.services`. */
  core: Core;
  /** Shared DB handle for plugin migrations + `ctx.db`. */
  db: DB;
  /** Plugin ids to load (from `ENABLED_PLUGINS`). */
  enabledIds: string[];
  /** Registry of known plugins (injectable for tests; defaults to the real one). */
  registry?: Record<string, () => Promise<PluginModule>>;
}

/** Short, safe error text for logs. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Assemble the {@link PluginContext} the host injects into a plugin. */
function buildContext(id: string, core: Core, db: DB): PluginContext {
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
  enabledIds,
  registry = PLUGIN_REGISTRY,
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
      ({ plugin } = await importer());
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
        await applyMigrations(db, plugin.migrations);
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
      registration = await plugin.register(buildContext(id, core, db));
    } catch (error) {
      logger.error("plugin_register_failed", { id, error: errorMessage(error) });
      continue;
    }

    loaded.push({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
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
