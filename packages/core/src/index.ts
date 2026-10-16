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
// Re-exported so the plugin loader can type a namespaced StorageProvider wrapper
// (for `ctx.storage`) without importing `@bunbooru/storage` directly.
export type { StoredObject } from "@bunbooru/storage";

// Mail transport contract — Core's dependency-inversion boundary for email
// (like StorageProvider). A plugin implements it and registers it through the
// SDK's `mailProvider`; Core's MailService holds the active one.
export type { MailProvider, OutgoingMail } from "./mail/mail-provider";

// Domain row types, re-exported so downstream apps depend on Core, not db directly.
export type {
  ApiKey,
  Asset,
  AssetUpdate,
  Rating,
  Tag,
  TagAlias,
  TagCategory,
  TagImplication,
  TagVersion,
  User,
  UserRole,
} from "@bunbooru/db";

// The Drizzle handle type + migration runner, re-exported so the plugin loader
// (and the SDK) reach them through Core rather than importing `@bunbooru/db`.
export type { DB } from "@bunbooru/db";
export {
  applyCoreMigrations,
  applyEmbeddedMigrations,
  applyPluginMigrations,
  type EmbeddedMigrationConfig,
  type EmbeddedMigrations,
} from "@bunbooru/db";

// Core assembly — the single wiring entry point for the API composition root.
export {
  assembleCore,
  createCore,
  createCoreRuntime,
  type Core,
  type CoreConfig,
  type CoreRuntime,
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
  requireTagName,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_TAG_LIMIT,
  MAX_HISTORY_LIMIT,
  MAX_TAG_LENGTH,
  MAX_TAG_LIMIT,
  type TagService,
  type TagServiceDeps,
} from "./services/tag-service";
// Durable job queue — the service (enqueue + handlers) and the runner that executes it.
export {
  createJobService,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  JOB_RETENTION,
  JobKindConflictError,
  type EnqueueOptions,
  type JobContext,
  type JobFailure,
  type JobHandler,
  type JobService,
} from "./jobs/job-service";
export { createJobRunner, retryDelayMs, type JobLogger, type JobRunner, type JobRunnerOptions } from "./jobs/job-runner";
export type { JobCount, JsonValue } from "@bunbooru/db";
// Plugin search metatags (`fav:`, `pool:`) — the registry the API's plugin host fills.
export {
  CORE_METATAG_KEYS,
  createSearchProviderRegistry,
  SearchProviderConflictError,
  type SearchProvider,
  type SearchProviderLookup,
  type SearchProviderRegistry,
  type SearchTerm,
} from "./search/providers";
// Tag gardening — aliases + implications (admin-managed; data access in @bunbooru/db).
export { createTagAliasService, type TagAliasService } from "./services/tag-alias-service";
export {
  createTagImplicationService,
  type TagImplicationService,
} from "./services/tag-implication-service";
export {
  DEFAULT_LIST_PER_PAGE,
  MAX_LIST_PER_PAGE,
  type Page,
} from "./services/paging";

// Traffic counters — per-post views (debounced) + daily unique visitors.
export {
  createStatsService,
  type StatsService,
  type SiteStats,
} from "./services/stats-service";

// Accounts + opaque server sessions + API keys — auth/currentUser + session GC.
export {
  createAuthService,
  MIN_PASSWORD_LENGTH,
  type ApiKeySummary,
  type AuthService,
  type AuthServiceConfig,
  type CreatedApiKey,
  type LoginResult,
  type PublicUser,
  type RegisterInput,
} from "./services/auth-service";

// Admin-editable runtime settings — upload caps + reset-verification policy.
export {
  createSettingsService,
  type SettingsDefaults,
  type SettingsService,
  type SettingsServiceConfig,
  type UploadLimits,
} from "./services/settings-service";

// Outgoing-mail hub — Core's dependency-inversion boundary for email delivery.
export {
  createLogMailProvider,
  createMailService,
  type MailLogger,
  type MailService,
} from "./mail/mail-service";

// Persisted plugin on/off state — the API's plugin host reads/writes this.
export {
  createPluginStateService,
  type PluginStateService,
} from "./services/plugin-state-service";

// Catalog of which DB tables each plugin owns — recorded by the host at load.
export {
  createPluginCatalogService,
  type PluginCatalogService,
  type PluginTableOwnership,
} from "./services/plugin-catalog-service";

// Authorization predicates — enforced on writes (owner-or-admin) + admin routes.
export { canModerate, canWrite, isOwnerOrAdmin } from "./services/permissions";

// Typed domain errors the API maps to HTTP status codes.
export {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  MailNotConfiguredError,
  MailProviderConflictError,
  RegistrationConflictError,
  UnsupportedMediaError,
  UploadConflictError,
  UploadRangeError,
  ValidationError,
} from "./errors";

/** Internal packages the Core composes over — mirrors this package's dependencies. */
export const CORE_DEPENDENCIES = [
  DB_PACKAGE,
  EVENTS_PACKAGE,
  SEARCH_PACKAGE,
  STORAGE_PACKAGE,
] as const;
