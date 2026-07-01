/**
 * Shared tag vocabulary for the UI: Danbooru-style categories and their colour
 * classes (presentational), plus the live tag API hooks (Eden Treaty). All tag
 * data — a post's tags, autocomplete, and related tags — comes from the API.
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

/** Group real tags by their category, preserving input order within each. */
export function groupTagsByCategory(tagList: readonly TagDto[]): Map<TagCategory, TagDto[]> {
  const grouped = new Map<TagCategory, TagDto[]>();
  for (const tag of tagList) {
    const list = grouped.get(tag.category) ?? [];
    list.push(tag);
    grouped.set(tag.category, list);
  }
  return grouped;
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

/**
 * Tags that co-occur with `name`, most-shared first (`GET /tags/:name/related`).
 * Disabled for an empty name so the popover only queries when it actually opens.
 */
export function useRelatedTags(name: string, limit = 10) {
  const trimmed = name.trim();
  return useQuery({
    queryKey: ["related-tags", trimmed, limit],
    enabled: trimmed.length > 0,
    queryFn: async (): Promise<TagDto[]> =>
      unwrap(await api.api.v1.tags({ name: trimmed }).related.get({ query: { limit } })),
  });
}

/** Colour class for a real tag's category (falls back to general). */
export function tagTextClass(category: TagDto["category"]): string {
  return TAG_TEXT_CLASS[category];
}
