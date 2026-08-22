// NOTE (intentional, re: CodeRabbit): Core depends on @bunbooru/db here — this is
// the SANCTIONED dependency edge (CLAUDE.md: apps → plugins → plugin-sdk → core →
// db; dependency-cruiser passes with 0 violations). Every Core service composes
// over a repository interface from @bunbooru/db (auth, settings, plugin-state,
// stats, …); this one is no different. We deliberately do NOT invert it into a
// Core-defined port or route persistence through the event bus — that would add
// an event-sourcing layer for a single catalog write and make this service
// inconsistent with the rest of Core, for no real benefit.
import { type PluginTableRepository } from "@bunbooru/db";

/** One plugin's owned tables, as surfaced to the admin console. */
export interface PluginTableOwnership {
  pluginId: string;
  /** Prefixed table names this plugin owns (e.g. `smtp_mailer_outbox`). */
  tables: string[];
}

/**
 * The catalog of which DB tables each plugin owns. The API's plugin host records
 * a plugin's declared tables here at load time; the admin console reads it so, at
 * any number of plugins, every table's owner is known (and a future uninstall
 * knows exactly what to drop). Core stays ignorant of what the tables mean.
 */
export interface PluginCatalogService {
  /** Record the tables a plugin owns — replaces its prior set. */
  record(pluginId: string, tableNames: readonly string[]): Promise<void>;
  /**
   * Record MANY plugins' tables in one atomic write — the host calls this once at
   * boot with every loaded plugin, so the catalog is never left partial.
   */
  recordAll(records: readonly PluginTableOwnership[]): Promise<void>;
  /** Owned tables grouped by plugin, table names sorted. */
  list(): Promise<PluginTableOwnership[]>;
}

/** Build a {@link PluginCatalogService} over a {@link PluginTableRepository}. */
export function createPluginCatalogService(repo: PluginTableRepository): PluginCatalogService {
  return {
    record(pluginId, tableNames) {
      // De-dupe defensively so a plugin declaring the same name twice is harmless.
      return repo.setForPlugin(pluginId, [...new Set(tableNames)]);
    },

    recordAll(records) {
      // Merge by pluginId (a defensive fold) so a repeated id can't produce two
      // sets for one plugin — each plugin yields one de-duplicated row group.
      const tablesByPlugin = new Map<string, Set<string>>();
      for (const { pluginId, tables } of records) {
        const set = tablesByPlugin.get(pluginId) ?? new Set<string>();
        for (const table of tables) set.add(table);
        tablesByPlugin.set(pluginId, set);
      }
      return repo.setAll(
        [...tablesByPlugin].map(([pluginId, set]) => ({ pluginId, tableNames: [...set] })),
      );
    },

    async list() {
      const rows = await repo.getAll();
      const byPlugin = new Map<string, string[]>();
      for (const row of rows) {
        const list = byPlugin.get(row.pluginId) ?? [];
        list.push(row.tableName);
        byPlugin.set(row.pluginId, list);
      }
      return [...byPlugin.entries()]
        .map(([pluginId, tables]) => ({ pluginId, tables: tables.sort() }))
        .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    },
  };
}
