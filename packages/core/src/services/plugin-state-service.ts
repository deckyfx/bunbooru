import type { PluginStateRepository } from "@bunbooru/db";

/**
 * The persisted activation state of first-party plugins. Core owns *which ids
 * are active* (host state); it stays deliberately ignorant of what each plugin
 * actually is — the concrete plugin registry lives in the API composition root.
 * The API's plugin host reads this on boot and writes it on every admin toggle.
 */
export interface PluginStateService {
  /** The ids currently marked active, as a set (order-independent membership). */
  activeIds(): Promise<Set<string>>;
  /** Persist one plugin's on/off state. */
  setActive(id: string, active: boolean): Promise<void>;
  /**
   * First-boot seed: if the table has NO rows at all, write the given ids as
   * active (and nothing else). A no-op once any row exists, so it never fights an
   * admin's later toggles. Returns whether it seeded.
   */
  seedIfEmpty(activeIds: readonly string[]): Promise<boolean>;
}

/** Build a {@link PluginStateService} over a {@link PluginStateRepository}. */
export function createPluginStateService(repo: PluginStateRepository): PluginStateService {
  return {
    async activeIds() {
      const rows = await repo.getAll();
      return new Set(rows.filter((r) => r.active).map((r) => r.id));
    },

    setActive(id, active) {
      return repo.setActive(id, active);
    },

    async seedIfEmpty(activeIds) {
      const rows = await repo.getAll();
      if (rows.length > 0) return false;
      // De-dupe so a repeated env id doesn't upsert twice.
      for (const id of new Set(activeIds)) await repo.setActive(id, true);
      return true;
    },
  };
}
