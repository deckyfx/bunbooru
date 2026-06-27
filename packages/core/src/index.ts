import { DB_PACKAGE } from "@bunbooru/db";
import { EVENTS_PACKAGE } from "@bunbooru/events";
import { SEARCH_PACKAGE } from "@bunbooru/search";
import { STORAGE_PACKAGE, type StorageProvider } from "@bunbooru/storage";

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
export const CORE_PACKAGE = "@bunbooru/core" as const;

export type { StorageProvider };

/** Internal packages the Core composes over — mirrors this package's dependencies. */
export const CORE_DEPENDENCIES = [
  DB_PACKAGE,
  EVENTS_PACKAGE,
  SEARCH_PACKAGE,
  STORAGE_PACKAGE,
] as const;
