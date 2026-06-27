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

/**
 * The integration points a plugin may register through this SDK.
 *
 * This vocabulary is SDK-owned and part of the public contract — intentionally
 * decoupled from internal package identifiers, so refactors inside
 * `core`/`auth`/`events`/`search` never become breaking SDK changes.
 */
export const SDK_CAPABILITIES = [
  "routes",
  "tables",
  "events",
  "search-providers",
  "storage-providers",
  "permissions",
  "jobs",
  "admin-pages",
  "navigation-items",
  "commands",
] as const;

/** A single capability a plugin may register through the SDK. */
export type SdkCapability = (typeof SDK_CAPABILITIES)[number];
