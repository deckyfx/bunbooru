import type {
  Tag,
  TagAliasRepository,
  TagCategory,
  TagImplicationRepository,
  TagRepository,
  TagVersion,
  TagVersionRepository,
} from "@bunbooru/db";

import { ValidationError } from "../errors";

/** Max characters in a normalized tag name (defensive bound on a single label). */
export const MAX_TAG_LENGTH = 100;
/** Default and ceiling result counts for autocomplete. */
export const DEFAULT_TAG_LIMIT = 20;
export const MAX_TAG_LIMIT = 100;
/** Default and ceiling page sizes for a post's tag history. */
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

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
 * Normalize a tag name from admin input (aliases, implications), or throw a
 * {@link ValidationError} naming its `role`. Stricter than tagging, which just
 * drops a bad name: `*` is refused, since it would make the name a search pattern.
 */
export function requireTagName(raw: string, role: string): string {
  const name = normalizeTagName(raw);
  if (name === null) throw new ValidationError(`The ${role} must be a tag name of 1-100 characters`);
  if (name.includes("*")) throw new ValidationError(`The ${role} can't contain "*"`);
  return name;
}

/**
 * Tag application logic — normalization, the vocabulary rules (aliases,
 * implications) and the set/diff workflow over a {@link TagRepository}. Holds no
 * SQL; the repository keeps `postCount`, the join and the history consistent
 * transactionally.
 */
export interface TagService {
  /**
   * Replace an asset's tags with the set parsed from `rawNames`:
   * 1. normalize and de-duplicate;
   * 2. rewrite aliased names to their consequent (`kitty` → `cat`);
   * 3. add everything those tags imply (`cat` → `animal`), transitively;
   * 4. create unknown tags and apply, recording a history version attributed to
   *    `editorId` (null for a system or plugin edit).
   *
   * An implied tag removed by hand comes straight back while its antecedent
   * stays, as on Danbooru. Returns the resulting tags in canonical order.
   */
  setAssetTags(assetId: number, rawNames: string[], editorId?: number | null): Promise<Tag[]>;
  /** A post's tag history, newest first; `beforeId` continues from a previous page. */
  history(assetId: number, options?: { limit?: number; beforeId?: number }): Promise<TagVersion[]>;
  /**
   * Restore the tag set recorded in `versionId`, as a NEW edit by `editorId`
   * (history only grows). It goes through the same rules as any edit, so an
   * alias created since then still applies. Null when the version doesn't exist
   * or belongs to another post.
   */
  revert(assetId: number, versionId: number, editorId: number | null): Promise<Tag[] | null>;
  /** The tags currently on an asset, in canonical order. */
  listForAsset(assetId: number): Promise<Tag[]>;
  /** Prefix autocomplete ordered by popularity; `limit` is clamped to a ceiling. */
  autocomplete(prefix: string, limit?: number): Promise<Tag[]>;
  /** Set a tag's category by name; null if no such tag. */
  setCategory(name: string, category: TagCategory): Promise<Tag | null>;
  /** Tags that co-occur with `name`, most-shared first; `limit` clamped. */
  relatedTags(name: string, limit?: number): Promise<Tag[]>;
  /** The distinct tags across the given assets (a page), for the sidebar. */
  tagsForAssets(assetIds: number[]): Promise<Tag[]>;
}

/** What the tag service reads and writes. */
export interface TagServiceDeps {
  tags: TagRepository;
  aliases: Pick<TagAliasRepository, "resolve">;
  implications: Pick<TagImplicationRepository, "closure">;
  versions: TagVersionRepository;
}

/** Clamp a caller-supplied count to `[1, max]`, defaulting non-finite input. */
function clampLimit(limit: number, fallback: number, max: number): number {
  const requested = Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(1, requested), max);
}

/** Build a {@link TagService} over its repositories. */
export function createTagService({ tags, aliases, implications, versions }: TagServiceDeps): TagService {
  async function setAssetTags(
    assetId: number,
    rawNames: string[],
    editorId: number | null = null,
  ): Promise<Tag[]> {
    const normalized = [
      ...new Set(rawNames.map(normalizeTagName).filter((n): n is string => n !== null)),
    ];
    // Aliases first, so an antecedent never comes back to life as a tag and
    // `kitty cat` collapses to one `cat`.
    const aliased = await aliases.resolve(normalized);
    const names = [...new Set(normalized.map((name) => aliased.get(name) ?? name))];

    const rows = names.length > 0 ? await tags.getOrCreateByNames(names) : [];
    const explicit = rows.map((t) => t.id);
    const implied = await implications.closure(explicit);
    await tags.setAssetTags(assetId, [...new Set([...explicit, ...implied])], editorId);
    // Re-read so the result is canonically ordered and reflects exactly what's
    // linked (the postCount on `rows` is pre-update; listForAsset is current).
    return tags.listForAsset(assetId);
  }

  return {
    setAssetTags,

    history(assetId, options = {}) {
      const limit = clampLimit(options.limit ?? DEFAULT_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      return versions.listForAsset(assetId, limit, options.beforeId);
    },

    async revert(assetId, versionId, editorId) {
      const version = await versions.findById(versionId);
      if (!version || version.assetId !== assetId) return null;
      return setAssetTags(assetId, version.tags, editorId);
    },

    listForAsset(assetId) {
      return tags.listForAsset(assetId);
    },

    autocomplete(prefix, limit = DEFAULT_TAG_LIMIT) {
      const normalized = normalizeTagName(prefix);
      if (normalized === null) return Promise.resolve([]);
      // Non-finite (NaN/Infinity) falls back to the default before clamping, so a
      // bad upstream value can't reach the repository as a NaN limit.
      return tags.searchByPrefix(normalized, clampLimit(limit, DEFAULT_TAG_LIMIT, MAX_TAG_LIMIT));
    },

    setCategory(name, category) {
      const normalized = normalizeTagName(name);
      if (normalized === null) return Promise.resolve(null);
      return tags.setCategory(normalized, category);
    },

    relatedTags(name, limit = DEFAULT_TAG_LIMIT) {
      const normalized = normalizeTagName(name);
      if (normalized === null) return Promise.resolve([]);
      return tags.relatedTags(normalized, clampLimit(limit, DEFAULT_TAG_LIMIT, MAX_TAG_LIMIT));
    },

    tagsForAssets(assetIds) {
      // De-duplicate + drop invalid ids before hitting the repository.
      const ids = [...new Set(assetIds.filter((id) => Number.isInteger(id) && id > 0))];
      return ids.length > 0 ? tags.tagsForAssets(ids) : Promise.resolve([]);
    },
  };
}
