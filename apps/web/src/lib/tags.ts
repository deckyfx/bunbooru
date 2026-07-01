/**
 * Shared tag vocabulary for the UI: Danbooru-style categories and their colour
 * classes (presentational), plus the live tag API hooks (Eden Treaty) at the
 * bottom. The static {@link TAG_CATALOG} below is a Phase-0 fixture still used by
 * the hover-preview popovers (which surface `related` tags the API doesn't model
 * yet); a post's real tags + autocomplete go through the hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TagDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

export type { TagDto };

export type TagCategory = "artist" | "copyright" | "character" | "general" | "meta";

/** Tag-name → text-colour class, matching the @theme tag-type tokens. */
export const TAG_TEXT_CLASS: Record<TagCategory, string> = {
  artist: "text-tag-artist",
  copyright: "text-tag-copyright",
  character: "text-tag-character",
  general: "text-tag-general",
  meta: "text-tag-meta",
};

/** Human label per category (also used so colour isn't the only signal). */
export const TAG_CATEGORY_LABEL: Record<TagCategory, string> = {
  artist: "Artist",
  copyright: "Copyright",
  character: "Character",
  general: "General",
  meta: "Meta",
};

export interface TagInfo {
  name: string;
  category: TagCategory;
  postCount: number;
  /** Frequently co-occurring tags (static for now). */
  related: string[];
}

/** Static fixture catalog. Phase 1 replaces lookups with the tag API. */
export const TAG_CATALOG: Record<string, TagInfo> = {
  original: { name: "original", category: "copyright", postCount: 1284931, related: ["highres", "1girl", "solo", "absurdres"] },
  hatsune_miku: { name: "hatsune_miku", category: "character", postCount: 284013, related: ["vocaloid", "twintails", "1girl", "aqua_hair"] },
  kantai_collection: { name: "kantai_collection", category: "copyright", postCount: 198442, related: ["1girl", "anchor", "thighhighs"] },
  vocaloid: { name: "vocaloid", category: "copyright", postCount: 412903, related: ["hatsune_miku", "1girl", "microphone"] },
  wlop: { name: "wlop", category: "artist", postCount: 4821, related: ["1girl", "realistic", "long_hair"] },
  "1girl": { name: "1girl", category: "general", postCount: 9281043, related: ["solo", "long_hair", "looking_at_viewer"] },
  solo: { name: "solo", category: "general", postCount: 7120388, related: ["1girl", "simple_background"] },
  long_hair: { name: "long_hair", category: "general", postCount: 5012933, related: ["1girl", "very_long_hair", "blue_hair"] },
  twintails: { name: "twintails", category: "general", postCount: 1543221, related: ["long_hair", "1girl", "ribbon"] },
  thighhighs: { name: "thighhighs", category: "general", postCount: 2210011, related: ["zettai_ryouiki", "skirt", "1girl"] },
  looking_at_viewer: { name: "looking_at_viewer", category: "general", postCount: 6620114, related: ["1girl", "smile", "blush"] },
  smile: { name: "smile", category: "general", postCount: 4123908, related: ["looking_at_viewer", "open_mouth", "blush"] },
  highres: { name: "highres", category: "meta", postCount: 6623110, related: ["absurdres", "commentary"] },
  absurdres: { name: "absurdres", category: "meta", postCount: 2210984, related: ["highres", "very_high_resolution"] },
  commentary: { name: "commentary", category: "meta", postCount: 1820445, related: ["commentary_request", "highres"] },
  aqua_hair: { name: "aqua_hair", category: "general", postCount: 340221, related: ["hatsune_miku", "long_hair"] },
  blue_hair: { name: "blue_hair", category: "general", postCount: 1980332, related: ["long_hair", "1girl"] },
  skirt: { name: "skirt", category: "general", postCount: 3120556, related: ["thighhighs", "pleated_skirt"] },
  ribbon: { name: "ribbon", category: "general", postCount: 2540998, related: ["hair_ribbon", "twintails"] },
};

/** All known tag names, for autocomplete. */
export const TAG_NAMES: readonly string[] = Object.keys(TAG_CATALOG);

/** Look up a tag, falling back to a plain general tag for unknown names. */
export function lookupTag(name: string): TagInfo {
  return TAG_CATALOG[name] ?? { name, category: "general", postCount: 0, related: [] };
}

/** Compact count, e.g. 9281043 → "9.3M", 4821 → "4.8k". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Booru sidebar ordering for tag categories. */
export const CATEGORY_ORDER: readonly TagCategory[] = [
  "copyright",
  "character",
  "artist",
  "general",
  "meta",
];

/** Group tag names by their category. */
export function groupByCategory(tags: readonly string[]): Map<TagCategory, string[]> {
  const grouped = new Map<TagCategory, string[]>();
  for (const name of tags) {
    const { category } = lookupTag(name);
    const list = grouped.get(category) ?? [];
    list.push(name);
    grouped.set(category, list);
  }
  return grouped;
}

/** Deterministic tag set for a post id, drawn from the catalog (static demo). */
export function postTags(id: number): string[] {
  // Sanitize: callers may pass Number(routeParam), which can be NaN/negative.
  const safeId = Number.isFinite(id) ? Math.abs(Math.trunc(id)) : 0;
  const out: string[] = [];
  const count = 4 + (safeId % 3);
  for (let k = 0; k < count; k++) {
    const name = TAG_NAMES[(safeId * 3 + k * 7) % TAG_NAMES.length];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// ─── Live tag API (Eden Treaty + TanStack Query) ─────────────────────────────

/** An asset's real tags, in canonical (category, name) order. */
export function useAssetTags(id: number) {
  return useQuery({
    queryKey: ["asset-tags", id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: async (): Promise<TagDto[]> =>
      unwrap(await api.api.v1.assets({ id: String(id) }).tags.get()),
  });
}

/**
 * Replace an asset's tag set via `PATCH /assets/:id/tags` (full list, Danbooru
 * style). On success refreshes the asset's tag query so the panel reflects the
 * server's normalized + de-duplicated result.
 */
export function useSetAssetTags(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tags: string[]) =>
      unwrap(await api.api.v1.assets({ id: String(id) }).tags.patch({ tags })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["asset-tags", id] }),
  });
}

/**
 * Set a tag's category (admin only — the server 403s otherwise) via
 * `PATCH /tags/:name`. Invalidates autocomplete so re-queried tags show the new
 * colour/category.
 */
export function useSetTagCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, category }: { name: string; category: TagCategory }): Promise<TagDto> =>
      unwrap(await api.api.v1.tags({ name }).patch({ category })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tag-autocomplete"] }),
  });
}

/**
 * Tag autocomplete by name prefix, popularity-ordered. Disabled (and resolves to
 * nothing) for an empty prefix so it only fires once the user has typed.
 */
export function useTagAutocomplete(prefix: string, limit = 10) {
  const trimmed = prefix.trim();
  return useQuery({
    queryKey: ["tag-autocomplete", trimmed, limit],
    enabled: trimmed.length > 0,
    queryFn: async () => unwrap(await api.api.v1.tags.get({ query: { q: trimmed, limit } })),
  });
}

/** Colour class for a real tag's category (falls back to general). */
export function tagTextClass(category: TagDto["category"]): string {
  return TAG_TEXT_CLASS[category];
}
