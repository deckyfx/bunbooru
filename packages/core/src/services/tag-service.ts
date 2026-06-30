import type { Tag, TagCategory, TagRepository } from "@bunbooru/db";

/** Max characters in a normalized tag name (defensive bound on a single label). */
export const MAX_TAG_LENGTH = 100;
/** Default and ceiling result counts for autocomplete. */
export const DEFAULT_TAG_LIMIT = 20;
export const MAX_TAG_LIMIT = 100;

/**
 * Normalize a raw tag name to canonical booru form: trimmed, lowercased, runs of
 * whitespace collapsed to single underscores. Returns `null` for a name that is
 * empty or longer than {@link MAX_TAG_LENGTH} after normalization, so callers can
 * drop it. Pure — exported for testing.
 */
export function normalizeTagName(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized.length === 0 || normalized.length > MAX_TAG_LENGTH) return null;
  return normalized;
}

/**
 * Tag application logic — normalization and the set/diff workflow over a
 * {@link TagRepository}. Holds no SQL; the repository keeps `postCount` and the
 * join consistent transactionally.
 */
export interface TagService {
  /**
   * Replace an asset's tags with the normalized, de-duplicated set parsed from
   * `rawNames` (unknown names are created). Returns the asset's resulting tags
   * in canonical order.
   */
  setAssetTags(assetId: number, rawNames: string[]): Promise<Tag[]>;
  /** The tags currently on an asset, in canonical order. */
  listForAsset(assetId: number): Promise<Tag[]>;
  /** Prefix autocomplete ordered by popularity; `limit` is clamped to a ceiling. */
  autocomplete(prefix: string, limit?: number): Promise<Tag[]>;
  /** Set a tag's category by name; null if no such tag. */
  setCategory(name: string, category: TagCategory): Promise<Tag | null>;
}

/** Build a {@link TagService} over a {@link TagRepository}. */
export function createTagService(tags: TagRepository): TagService {
  return {
    async setAssetTags(assetId, rawNames) {
      const names = [
        ...new Set(rawNames.map(normalizeTagName).filter((n): n is string => n !== null)),
      ];
      const rows = names.length > 0 ? await tags.getOrCreateByNames(names) : [];
      await tags.setAssetTags(
        assetId,
        rows.map((t) => t.id),
      );
      // Re-read so the result is canonically ordered and reflects exactly what's
      // linked (the postCount on `rows` is pre-update; listForAsset is current).
      return tags.listForAsset(assetId);
    },

    listForAsset(assetId) {
      return tags.listForAsset(assetId);
    },

    autocomplete(prefix, limit = DEFAULT_TAG_LIMIT) {
      const normalized = normalizeTagName(prefix);
      if (normalized === null) return Promise.resolve([]);
      // Coerce non-finite (NaN/Infinity) to the default before clamping, so a bad
      // upstream value can't reach the repository as a NaN limit.
      const requested = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TAG_LIMIT;
      const clamped = Math.min(Math.max(1, requested), MAX_TAG_LIMIT);
      return tags.searchByPrefix(normalized, clamped);
    },

    setCategory(name, category) {
      const normalized = normalizeTagName(name);
      if (normalized === null) return Promise.resolve(null);
      return tags.setCategory(normalized, category);
    },
  };
}
