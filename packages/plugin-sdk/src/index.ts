import { AUTH_PACKAGE } from "@bunbooru/auth";
import { CORE_DEPENDENCIES } from "@bunbooru/core";
import { EVENTS_PACKAGE } from "@bunbooru/events";
import { SEARCH_PACKAGE } from "@bunbooru/search";
import type { StorageProvider } from "@bunbooru/storage";

/**
 * `@bunbooru/plugin-sdk` — the single integration surface for feature modules.
 *
 * Plugins (optional, first-party, toggled on/off via config) import ONLY this
 * package — never `core` or `db` directly. Keeping this surface stable is what
 * lets features stay cleanly removable and keeps Core unaware they exist.
 *
 * The concrete registration API (routes, tables, events, search providers,
 * permissions, jobs) lands in later PRs.
 */
export const PLUGIN_SDK_VERSION = "0.1.0" as const;

/** Storage contract re-exported for plugins that register storage providers. */
export type { StorageProvider };

/** Core capabilities a plugin may integrate with, exposed through the SDK only. */
export const SDK_CAPABILITIES = {
  core: CORE_DEPENDENCIES,
  auth: AUTH_PACKAGE,
  events: EVENTS_PACKAGE,
  search: SEARCH_PACKAGE,
} as const;
