/**
 * Per-user API-key management via Eden Treaty + TanStack Query. The raw `bnb_…`
 * key is returned only once, by {@link useCreateApiKey}; listing never returns it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ApiKeyDto } from "@bunbooru/api";

import { api, unwrap } from "./api";
import { useCurrentUser } from "./auth";

export type { ApiKeyDto };

/** An {@link ApiKeyDto} plus the one-time secret returned at creation. */
export type CreatedApiKeyDto = ApiKeyDto & { key: string };

/** Query key namespace — scoped by user id so one account never sees another's
 *  cached keys across a logout/login. Mutations invalidate by this prefix. */
const API_KEYS_KEY = ["api-keys"] as const;

/** The caller's API keys (no secrets), newest first. */
export function useApiKeys() {
  const { data: user } = useCurrentUser();
  return useQuery({
    queryKey: [...API_KEYS_KEY, user?.id],
    enabled: user != null,
    queryFn: async (): Promise<ApiKeyDto[]> => unwrap(await api.api.v1.account["api-keys"].get()),
  });
}

/** Mint a named key; the response carries the raw token to show once. */
export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<CreatedApiKeyDto> =>
      unwrap(await api.api.v1.account["api-keys"].post({ name })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: API_KEYS_KEY }),
  });
}

/** Revoke a key by id (204, empty body — so we check `error`, not `unwrap`). */
export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await api.api.v1.account["api-keys"]({ id: String(id) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: API_KEYS_KEY }),
  });
}
