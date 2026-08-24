/**
 * Effective server runtime configuration (admin-only, read-only).
 *
 * Answers "what is this server actually using?" without shelling in to read
 * `.env`. Core settings only — a plugin's own configuration lives in that
 * plugin's admin section, which renders only while the plugin is active.
 */
import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "./api";

/** Where a setting's effective value came from. */
export type SettingSource = "env" | "default" | "database";

/** One runtime setting row. */
export interface RuntimeSetting {
  key: string;
  /** Effective value, already MASKED server-side when `secret`. Null when unset. */
  value: string | null;
  source: SettingSource;
  secret: boolean;
  note?: string;
}

/** A titled group of settings. */
export interface RuntimeSection {
  title: string;
  settings: RuntimeSetting[];
}

/**
 * The server's runtime configuration. Environment only changes on restart, so
 * this is cached for the session rather than refetched — the runtime-overridable
 * values (upload caps, reset policy) are edited elsewhere on the same page and
 * invalidate this key when they change.
 */
export function useRuntimeConfig() {
  return useQuery({
    queryKey: RUNTIME_CONFIG_KEY,
    staleTime: 60_000,
    queryFn: async (): Promise<RuntimeSection[]> =>
      unwrap(await api.api.v1.admin.runtime.get()),
  });
}

/** Query key, so the settings mutations can refresh the displayed values. */
export const RUNTIME_CONFIG_KEY = ["admin-runtime-config"] as const;
