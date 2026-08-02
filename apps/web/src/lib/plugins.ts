import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ExtensionDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

export type { ExtensionDto };

/**
 * The active plugins on the server, from `GET /api/v1/plugins`. Drives which
 * plugin admin sections the console renders. Short stale time so an admin
 * activating/deactivating a plugin is reflected across the app promptly.
 */
export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: async () => unwrap(await api.api.v1.plugins.get()),
    staleTime: 15_000,
  });
}

/**
 * Every known first-party plugin with metadata + on/off state, from
 * `GET /api/v1/admin/extensions` (admin only). Powers the Extensions management
 * page. Kept fresh (no long stale time) so a toggle shows immediately.
 */
export function useExtensions() {
  return useQuery({
    queryKey: ["extensions"],
    queryFn: async (): Promise<ExtensionDto[]> => unwrap(await api.api.v1.admin.extensions.get()),
  });
}

/**
 * Activate or deactivate a plugin at runtime (`POST /admin/extensions/:id/{activate,deactivate}`).
 * On success refreshes both the management list and the active-plugin manifest so
 * the sidebar + any plugin tool sections update without a reload.
 */
export function useToggleExtension() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }): Promise<ExtensionDto> => {
      const endpoint = api.api.v1.admin.extensions({ id });
      return unwrap(active ? await endpoint.activate.post() : await endpoint.deactivate.post());
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["extensions"] }),
        queryClient.invalidateQueries({ queryKey: ["plugins"] }),
      ]);
    },
  });
}
