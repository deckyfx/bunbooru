/**
 * First-run setup state (Eden Treaty + TanStack Query).
 *
 * An instance with zero accounts has never been set up: there is no way to log
 * in and no way to create an admin from the UI, so the whole site redirects to
 * `/setup` until the first account exists. `GET /setup/status` is the gate the
 * root layout consults on every load; `GET /setup/checks` is the diagnostics
 * panel and is only served while setup is still pending.
 */
import { useQuery } from "@tanstack/react-query";

import type { SetupCheckDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

/** Query key for the setup gate, shared with the invalidation after setup. */
export const SETUP_STATUS_KEY = ["setup-status"] as const;

/**
 * One first-run diagnostic. Re-exported from the API rather than restated here:
 * a duplicated shape drifts silently, and a new `status` value added server-side
 * must become a compile error in the UI that switches on it, not a blank cell.
 */
export type SetupCheck = SetupCheckDto;

/**
 * Whether this instance still needs first-run setup.
 *
 * `staleTime: Infinity` on purpose — setup happens once per deployment, and this
 * runs on every route change, so refetching would be pure overhead. The setup
 * flow invalidates {@link SETUP_STATUS_KEY} explicitly once the admin exists.
 */
export function useSetupStatus() {
  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // Don't strand a first-time operator on a spinner because of one blip, but
    // don't hammer a server that's genuinely down either.
    retry: 1,
    queryFn: async (): Promise<boolean> =>
      unwrap(await api.api.v1.setup.status.get()).needsSetup,
  });
}

/**
 * First-run environment diagnostics. Only meaningful while setup is pending —
 * the endpoint 404s afterwards — so callers should render it on `/setup` only.
 */
export function useSetupChecks() {
  return useQuery({
    queryKey: ["setup-checks"] as const,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async (): Promise<{ checks: SetupCheck[]; canProceed: boolean }> =>
      unwrap(await api.api.v1.setup.checks.get()),
  });
}
