import { DB_PACKAGE } from "@bunbooru/db";
import { EVENTS_PACKAGE } from "@bunbooru/events";
import { SEARCH_PACKAGE } from "@bunbooru/search";
import type { StorageProvider } from "@bunbooru/storage";

/**
 * `@bunbooru/core` — the small, stable Core.
 *
 * Owns only: Asset, Tag, Collection, User, Permission, plus the Search Engine,
 * Event Bus, and Plugin SDK surface. No optional features ever live here.
 * Domain models and services land in later PRs.
 *
 * This module also re-exports the storage contract so downstream packages
 * depend on Core rather than reaching past it.
 */
export type { StorageProvider };

/** Internal packages the Core composes over (proves the inward dependency edges). */
export const CORE_DEPENDENCIES = [DB_PACKAGE, EVENTS_PACKAGE, SEARCH_PACKAGE] as const;
