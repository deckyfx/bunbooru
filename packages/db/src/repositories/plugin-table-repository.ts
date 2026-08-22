import { eq, inArray } from "drizzle-orm";

import { pluginTables, type PluginTable } from "../schema";
import type { DB } from "../client";

/** One plugin's owned (actual) table names, for a batch catalog write. */
export interface PluginTablesRecord {
  pluginId: string;
  tableNames: string[];
}

/**
 * Data access for the {@link pluginTables} catalog — the record of which tables
 * each plugin owns (the sole SQL layer per CLAUDE.md). The host writes this at
 * load time; the admin console reads it.
 */
export interface PluginTableRepository {
  /** Every catalog row (all plugins). */
  getAll(): Promise<PluginTable[]>;
  /**
   * Replace the recorded tables for one plugin with exactly `tableNames` (already
   * prefixed, e.g. `smtp_mailer_outbox`). Idempotent and self-correcting — safe
   * to call on every boot; adding/removing a plugin's table stays in sync.
   */
  setForPlugin(pluginId: string, tableNames: string[]): Promise<void>;
  /**
   * Replace the recorded tables for MANY plugins in ONE transaction — the host
   * calls this once at boot with every loaded plugin, so the catalog is never
   * left partial if a single write fails. Only the given plugins' rows change;
   * others are preserved.
   */
  setAll(records: PluginTablesRecord[]): Promise<void>;
}

/** Build a {@link PluginTableRepository} over a {@link DB} handle. */
export function createPluginTableRepository(db: DB): PluginTableRepository {
  return {
    getAll() {
      return db.select().from(pluginTables);
    },

    async setForPlugin(pluginId, tableNames) {
      // Replace-all in one transaction so the catalog can never be left partial.
      await db.transaction(async (tx) => {
        await tx.delete(pluginTables).where(eq(pluginTables.pluginId, pluginId));
        if (tableNames.length > 0) {
          await tx
            .insert(pluginTables)
            .values(tableNames.map((tableName) => ({ pluginId, tableName })));
        }
      });
    },

    async setAll(records) {
      const ids = records.map((r) => r.pluginId);
      const rows = records.flatMap((r) =>
        r.tableNames.map((tableName) => ({ pluginId: r.pluginId, tableName })),
      );
      // One transaction: clear the given plugins' rows, then insert the new set —
      // atomic replace so a mid-loop failure can't leave the catalog half-written.
      await db.transaction(async (tx) => {
        if (ids.length > 0) await tx.delete(pluginTables).where(inArray(pluginTables.pluginId, ids));
        if (rows.length > 0) await tx.insert(pluginTables).values(rows);
      });
    },
  };
}
