/**
 * Tag gardening hooks (Eden Treaty + TanStack Query): aliases (`kitty` means
 * `cat`) and implications (`cat` implies `animal`). Lists are public; creating
 * and deleting are admin-only on the server.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { PageDto, TagAliasDto, TagImplicationDto } from "@bunbooru/api";

import { api, pathParam, unwrap } from "./api";

export type { TagAliasDto, TagImplicationDto };

/** Page size for the admin lists. */
const PER_PAGE = 50;

const ALIASES_KEY = ["tag-aliases"] as const;
const IMPLICATIONS_KEY = ["tag-implications"] as const;

/**
 * Both kinds of change rewrite posts' tags (an alias migrates them, an
 * implication backfills them), so every cached view of tags is now stale.
 */
function invalidateTagViews(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all(
    ["asset-tags", "page-tags", "tag-autocomplete", "related-tags", "tag-history", "assets"].map(
      (key) => queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}

/** One page of aliases, ordered by antecedent name. */
export function useTagAliases(page: number) {
  return useQuery({
    queryKey: [...ALIASES_KEY, page],
    queryFn: async (): Promise<PageDto<TagAliasDto>> =>
      unwrap(await api.api.v1["tag-aliases"].get({ query: { page, perPage: PER_PAGE } })),
  });
}

/** Create an alias; resolves to how many posts were migrated. */
export function useCreateTagAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pair: { antecedent: string; consequent: string }) =>
      unwrap(await api.api.v1["tag-aliases"].post(pair)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ALIASES_KEY }),
        invalidateTagViews(queryClient),
      ]),
  });
}

/** Delete an alias by antecedent name. Migrated posts keep the consequent. */
export function useDeleteTagAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (antecedent: string) => {
      const res = await api.api.v1["tag-aliases"]({ name: pathParam(antecedent) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ALIASES_KEY }),
  });
}

/** One page of implications, ordered by antecedent then consequent. */
export function useTagImplications(page: number) {
  return useQuery({
    queryKey: [...IMPLICATIONS_KEY, page],
    queryFn: async (): Promise<PageDto<TagImplicationDto>> =>
      unwrap(await api.api.v1["tag-implications"].get({ query: { page, perPage: PER_PAGE } })),
  });
}

/** Create an implication; resolves to how many posts were backfilled. */
export function useCreateTagImplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pair: { antecedent: string; consequent: string }) =>
      unwrap(await api.api.v1["tag-implications"].post(pair)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: IMPLICATIONS_KEY }),
        invalidateTagViews(queryClient),
      ]),
  });
}

/** Delete an implication. Tags it already added stay on their posts. */
export function useDeleteTagImplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pair: { antecedent: string; consequent: string }) => {
      const res = await api.api.v1["tag-implications"]({ antecedent: pathParam(pair.antecedent) })({
        consequent: pathParam(pair.consequent),
      }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IMPLICATIONS_KEY }),
  });
}
