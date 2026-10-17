import { treaty } from "@elysiajs/eden";

import type { BannedHashesPluginApp } from "@bunbooru/plugin-banned-hashes";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the banned-hashes plugin's routes, built from the
 * plugin's own exported {@link BannedHashesPluginApp} type (paths include the
 * `/api/v1/plugins/banned-hashes` prefix).
 */
export const bannedHashesApi = treaty<BannedHashesPluginApp>(treatyOrigin, treatyOptions);

/** The plugin's routes. */
export const bansApi = bannedHashesApi.api.v1.plugins["banned-hashes"];

/** Query keys: every ban query sits under this prefix, so a change refreshes them all. */
export const BANS_KEY = ["banned-hashes"] as const;
