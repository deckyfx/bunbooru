import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "./api";

/**
 * The enabled plugins active on the server, from `GET /api/v1/plugins`. Drives
 * which plugin admin sections the console renders. Cached with a long stale time
 * — the set only changes on a server restart (config change), not during a
 * session.
 */
export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: async () => unwrap(await api.api.v1.plugins.get()),
    staleTime: Infinity,
  });
}
