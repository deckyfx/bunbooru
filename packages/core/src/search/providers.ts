import type { SQL } from "drizzle-orm";

import type { CompareOp } from "@bunbooru/search";

/** One metatag term handed to a provider: `fav:alice` → `{ op: "eq", value: "alice" }`. */
export interface SearchTerm {
  op: CompareOp;
  value: string;
}

/**
 * A metatag contributed by a plugin (`fav:alice`, `pool:12`). Core calls
 * {@link SearchProvider.compile} for each matching term in a query and composes
 * the returned condition with every other term (AND, OR, negation), so a
 * plugin's metatag behaves exactly like a built-in one.
 *
 * The condition must reference only the plugin's OWN tables, correlated to the
 * post being matched through `asset.id`, e.g.
 * `exists (select 1 from favorites_posts f where f.asset_id = ${asset.id} …)`.
 * Bind values as parameters (Drizzle `sql` interpolation), never splice text.
 */
export interface SearchProvider {
  /** The metatag key, lowercase (`fav`). Must not collide with a Core key or another plugin's. */
  key: string;
  /**
   * The condition for one term, or undefined to ignore a term it can't
   * understand (the same rule as Core's metatags). May be async, e.g. to resolve
   * a username through `ctx.services.auth`.
   */
  compile(term: SearchTerm, asset: { id: SQL }): SQL | undefined | Promise<SQL | undefined>;
}

/** Metatag keys Core handles itself; a plugin may not claim any of them. */
export const CORE_METATAG_KEYS: ReadonlySet<string> = new Set([
  "rating",
  "md5",
  "user",
  "date",
  "order",
  "id",
  "width",
  "height",
  "size",
  "views",
  "tagcount",
]);

/** A valid provider key: starts with a letter; letters, digits, underscores. */
const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** A provider key that's malformed, a Core key, or owned by another plugin. */
export class SearchProviderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchProviderConflictError";
  }
}

/** Read access to the active providers, as the search compiler needs it. */
export interface SearchProviderLookup {
  get(key: string): SearchProvider | undefined;
}

/**
 * The live set of plugin search providers. The API's plugin host registers a
 * plugin's providers when it activates and removes them when it deactivates, so
 * a deactivated plugin's metatag stops matching immediately (its terms are then
 * ignored, like any unknown key).
 */
export interface SearchProviderRegistry extends SearchProviderLookup {
  /**
   * Install `providers` for `ownerId`, replacing whatever it had. All-or-nothing:
   * throws {@link SearchProviderConflictError} without changing anything if any
   * key is malformed, a Core key, repeated, or already owned by another plugin.
   */
  register(ownerId: string, providers: readonly SearchProvider[]): void;
  /** Remove every provider `ownerId` registered (no-op if none). */
  unregister(ownerId: string): void;
  /** Every registered key, with its owner. */
  entries(): { key: string; ownerId: string }[];
}

/** Build an empty {@link SearchProviderRegistry}. */
export function createSearchProviderRegistry(): SearchProviderRegistry {
  const byKey = new Map<string, { ownerId: string; provider: SearchProvider }>();

  return {
    register(ownerId, providers) {
      const seen = new Set<string>();
      for (const { key } of providers) {
        if (!KEY_RE.test(key)) {
          throw new SearchProviderConflictError(`Search key "${key}" from ${ownerId} is not a valid metatag key`);
        }
        if (CORE_METATAG_KEYS.has(key)) {
          throw new SearchProviderConflictError(`Search key "${key}" from ${ownerId} is reserved by Core`);
        }
        if (seen.has(key)) {
          throw new SearchProviderConflictError(`Search key "${key}" is declared twice by ${ownerId}`);
        }
        seen.add(key);
        const existing = byKey.get(key);
        if (existing && existing.ownerId !== ownerId) {
          throw new SearchProviderConflictError(
            `Search key "${key}" from ${ownerId} is already provided by ${existing.ownerId}`,
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
