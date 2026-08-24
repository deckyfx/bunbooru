/**
 * Effective server runtime configuration (admin-only, read-only).
 *
 * Answers "what is this server actually using?" without shelling in to read
 * `.env`. Core settings only — a plugin's own configuration lives in that
 * plugin's admin section, which renders only while the plugin is active.
 */
import { useQuery } from "@tanstack/react-query";

import type {
  RuntimeSectionDto,
  RuntimeSettingDto,
  SettingSource as SettingSourceDto,
} from "@bunbooru/api";

import { api, unwrap } from "./api";

/**
 * Wire shapes for the runtime panel, re-exported from the API rather than
 * restated here — see the note in `setup.ts`. Values arrive already masked.
 */
export type SettingSource = SettingSourceDto;
export type RuntimeSetting = RuntimeSettingDto;
export type RuntimeSection = RuntimeSectionDto;

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
