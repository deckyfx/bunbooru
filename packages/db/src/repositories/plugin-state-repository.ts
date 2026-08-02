import { pluginStates, type PluginState } from "../schema";
import type { DB } from "../client";

/**
 * Data access for the {@link pluginStates} table — the persisted on/off state of
 * first-party plugins (the sole SQL layer per CLAUDE.md). The plugin-state
 * service owns the seeding + activation policy; this only reads and upserts rows.
 */
export interface PluginStateRepository {
  /** Every stored plugin-state row (empty on a fresh install, before seeding). */
  getAll(): Promise<PluginState[]>;
  /** Upsert one plugin's `active` flag, stamping `updatedAt`. */
  setActive(id: string, active: boolean): Promise<void>;
}

/** Build a {@link PluginStateRepository} over a {@link DB} handle. */
export function createPluginStateRepository(db: DB): PluginStateRepository {
  return {
    getAll() {
      return db.select().from(pluginStates);
    },

    async setActive(id, active) {
      const updatedAt = new Date();
      await db
        .insert(pluginStates)
        .values({ id, active, updatedAt })
        .onConflictDoUpdate({ target: pluginStates.id, set: { active, updatedAt } });
    },
  };
}
