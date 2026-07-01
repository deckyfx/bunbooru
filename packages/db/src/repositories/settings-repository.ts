import { settings } from "../schema";
import type { DB } from "../client";

/**
 * Data access for the runtime {@link settings} key-value store (the sole SQL
 * layer per CLAUDE.md). Values are opaque text here; the settings service owns
 * parsing/validation and the env-derived defaults.
 */
export interface SettingsRepository {
  /** All override rows as a `key → value` map (empty when nothing is overridden). */
  getAll(): Promise<Record<string, string>>;
  /** Upsert one setting, recording which admin (`updatedBy`) changed it. */
  set(key: string, value: string, updatedBy: number | null): Promise<void>;
}

/** Build a {@link SettingsRepository} over a {@link DB} handle. */
export function createSettingsRepository(db: DB): SettingsRepository {
  return {
    async getAll() {
      const rows = await db.select().from(settings);
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    },

    async set(key, value, updatedBy) {
      const updatedAt = new Date();
      await db
        .insert(settings)
        .values({ key, value, updatedBy, updatedAt })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedBy, updatedAt },
        });
    },
  };
}
