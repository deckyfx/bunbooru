import type { SQL } from "drizzle-orm";

import { CORE_ORDER_KEYS } from "./core-orders";

/**
 * A sort key contributed by a plugin (`order:score`). Core orders a listing by
 * `(value, id)`, ties broken by id, and pages through it with a keyset, so a
 * plugin's sort behaves like a built-in one: `order:<key>` sorts biggest first,
 * `order:<key>_asc` smallest first, `order:<key>_desc` biggest first.
 *
 * `value` returns a NUMERIC expression for one post, correlated to it through
 * `asset.id` and over the plugin's OWN tables only, and it must never be null
 * (coalesce it), e.g.
 * `coalesce((select score from scores_totals t where t.asset_id = ${asset.id}), 0)`.
 * A plugin value may change between page requests (a score does); a post whose
 * value moves mid-browse can then repeat or be skipped, as with `order:views`.
 */
export interface SortProvider {
  /** The sort key, lowercase (`score`). Must not collide with a Core order key or another plugin's. */
  key: string;
  /** The post's sort value, as a numeric, never-null SQL expression correlated to `asset.id`. */
  value(asset: { id: SQL }): SQL;
}

/**
 * A valid sort key: starts with a letter; letters, digits, underscores. It may
 * not end in `_asc` / `_desc`, which name the direction (`order:score_asc`).
 */
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const DIRECTION_SUFFIX_RE = /_(asc|desc)$/;

/** A sort key that's malformed, a Core order key, or owned by another plugin. */
export class SortProviderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SortProviderConflictError";
  }
}

/** Read access to the active sort providers, as the order parser needs it. */
export interface SortProviderLookup {
  get(key: string): SortProvider | undefined;
}

/**
 * The live set of plugin sort providers. The API's plugin host registers a
 * plugin's providers when it activates and removes them when it deactivates,
 * so a deactivated plugin's `order:` key falls back to the default order
 * (like any unknown order), and its outstanding cursors stop matching.
 */
export interface SortProviderRegistry extends SortProviderLookup {
  /**
   * Install `providers` for `ownerId`, replacing whatever it had. All-or-nothing:
   * throws {@link SortProviderConflictError} without changing anything if any
   * key is malformed, a Core order key, repeated, or already owned by another plugin.
   */
  register(ownerId: string, providers: readonly SortProvider[]): void;
  /** Remove every provider `ownerId` registered (no-op if none). */
  unregister(ownerId: string): void;
  /** Every registered key, with its owner. */
  entries(): { key: string; ownerId: string }[];
}

/** Build an empty {@link SortProviderRegistry}. */
export function createSortProviderRegistry(): SortProviderRegistry {
  const byKey = new Map<string, { ownerId: string; provider: SortProvider }>();

  return {
    register(ownerId, providers) {
      const seen = new Set<string>();
      for (const { key } of providers) {
        if (!KEY_RE.test(key)) {
          throw new SortProviderConflictError(`Sort key "${key}" from ${ownerId} is not a valid order key`);
        }
        if (DIRECTION_SUFFIX_RE.test(key)) {
          throw new SortProviderConflictError(
            `Sort key "${key}" from ${ownerId} may not end in _asc or _desc (those name the direction)`,
          );
        }
        if (CORE_ORDER_KEYS.has(key)) {
          throw new SortProviderConflictError(`Sort key "${key}" from ${ownerId} is reserved by Core`);
        }
        if (seen.has(key)) {
          throw new SortProviderConflictError(`Sort key "${key}" is declared twice by ${ownerId}`);
        }
        seen.add(key);
        const existing = byKey.get(key);
        if (existing && existing.ownerId !== ownerId) {
          throw new SortProviderConflictError(
            `Sort key "${key}" from ${ownerId} is already provided by ${existing.ownerId}`,
          );
        }
      }
      // Validated as a whole; now swap this owner's set in.
      for (const [key, entry] of byKey) if (entry.ownerId === ownerId) byKey.delete(key);
      for (const provider of providers) byKey.set(provider.key, { ownerId, provider });
    },

    unregister(ownerId) {
      for (const [key, entry] of byKey) if (entry.ownerId === ownerId) byKey.delete(key);
    },

    get(key) {
      return byKey.get(key)?.provider;
    },

    entries() {
      return [...byKey].map(([key, { ownerId }]) => ({ key, ownerId }));
    },
  };
}
