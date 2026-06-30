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

// Domain row types, re-exported so downstream apps depend on Core, not db directly.
export type { Asset, AssetUpdate, Rating, Tag, TagCategory, User } from "@bunbooru/db";

// Core assembly — the single wiring entry point for the API composition root.
export {
  assembleCore,
  createCore,
  type Core,
  type CoreConfig,
} from "./core";

// Event bus — Core emits domain events; plugins subscribe (CLAUDE.md Event Rule).
export {
  createCoreEvents,
  type AssetCreatedEvent,
  type CoreEventMap,
  type CoreEvents,
} from "./events";

// Asset domain — application service (data access lives in @bunbooru/db).
export {
  createAssetService,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  type AssetFile,
  type AssetListPage,
  type AssetService,
  type CreateAssetInput,
  type CreateAssetResult,
  type ListAssetsOptions,
} from "./services/asset-service";

// Resumable chunked uploads — stage chunks, finalize through the asset pipeline.
export {
  createUploadService,
  type AppendChunkResult,
  type BeginUploadInput,
  type UploadBegun,
  type UploadService,
} from "./services/upload-service";

// Tag domain — normalization + asset↔tag application (data access in @bunbooru/db).
export {
  createTagService,
  normalizeTagName,
  DEFAULT_TAG_LIMIT,
  MAX_TAG_LENGTH,
  MAX_TAG_LIMIT,
  type TagService,
} from "./services/tag-service";

// Typed domain errors the API maps to HTTP status codes.
export { UnsupportedMediaError, UploadConflictError, UploadRangeError } from "./errors";

/** Internal packages the Core composes over — mirrors this package's dependencies. */
export const CORE_DEPENDENCIES = [
  DB_PACKAGE,
  EVENTS_PACKAGE,
  SEARCH_PACKAGE,
  STORAGE_PACKAGE,
] as const;
