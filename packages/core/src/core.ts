import { join } from "node:path";

import {
  createApiKeyRepository,
  createAssetRepository,
  createDb,
  createSessionRepository,
  createSettingsRepository,
  createStatsRepository,
  createTagRepository,
  createUploadSessionRepository,
  createUserRepository,
  type DB,
} from "@bunbooru/db";
import {
  createFilesystemStaging,
  createFilesystemStorageProvider,
  type StagingStore,
  type StorageProvider,
} from "@bunbooru/storage";

import { createCoreEvents, type CoreEvents } from "./events";
import { createAssetService, type AssetService } from "./services/asset-service";
import { createAuthService, type AuthService } from "./services/auth-service";
import { createSettingsService, type SettingsService } from "./services/settings-service";
import { createStatsService, type StatsService } from "./services/stats-service";
import { createTagService, type TagService } from "./services/tag-service";
import { createUploadService, type UploadService } from "./services/upload-service";

/**
 * The assembled Core: the application services the API (and later, plugins via
 * the SDK) compose over. Adding a domain means adding a service here, not a new
 * dependency edge from `apps/*` into `@bunbooru/db` or `@bunbooru/storage`.
 */
export interface Core {
  assetService: AssetService;
  /** Resumable chunked uploads — stages chunks, then finalizes via `assetService`. */
  uploadService: UploadService;
  /** Tag taxonomy + asset↔tag application (normalization, set/diff, postCount). */
  tagService: TagService;
  /** Traffic counters — per-post views (debounced) + daily unique visitors. */
  statsService: StatsService;
  /** Accounts + opaque server sessions + API keys — auth/currentUser + session GC. */
  authService: AuthService;
  /** Admin-editable runtime settings (upload caps) — env defaults + DB overrides. */
  settingsService: SettingsService;
  /** Typed pub/sub bus — Core emits domain events (e.g. `asset.created`); plugins subscribe. */
  events: CoreEvents;
}

/** Runtime configuration needed to stand up the Core. */
export interface CoreConfig {
  /** Postgres connection string (e.g. `envConfig.DATABASE_URL`). */
  databaseUrl: string;
  /** Filesystem root under which asset binaries are stored. */
  storageRoot: string;
  /** Default one-shot `POST /assets` cap (bytes); admin-overridable at runtime. */
  maxUploadBytes: number;
  /** Default resumable-upload cap (bytes); admin-overridable at runtime. */
  maxResumableUploadBytes: number;
  /** Hard ceiling for the one-shot cap (the HTTP request-body limit). */
  requestBodyCeilingBytes: number;
  /** Login session lifetime in milliseconds (e.g. 30 days). */
  sessionExpiryMs: number;
}

/** Numeric limits {@link assembleCore} needs, grouped to avoid a long arg list. */
export interface CoreLimits {
  maxUploadBytes: number;
  maxResumableUploadBytes: number;
  requestBodyCeilingBytes: number;
  sessionExpiryMs: number;
}

/**
 * Wire the Core over existing {@link DB} and {@link StorageProvider} handles.
 *
 * Separated from {@link createCore} so integration tests can inject a shared
 * connection and a throwaway storage root.
 */
export function assembleCore(
  db: DB,
  storage: StorageProvider,
  staging: StagingStore,
  limits: CoreLimits,
): Core {
  const events = createCoreEvents();
  const assetService = createAssetService(createAssetRepository(db), storage, events);
  const settingsService = createSettingsService(createSettingsRepository(db), {
    defaults: {
      maxUploadBytes: limits.maxUploadBytes,
      maxResumableUploadBytes: limits.maxResumableUploadBytes,
    },
    requestBodyCeilingBytes: limits.requestBodyCeilingBytes,
  });
  const uploadService = createUploadService(
    createUploadSessionRepository(db),
    staging,
    assetService,
    // Read the (runtime-editable) resumable cap at call time.
    () => settingsService.getUploadLimits().then((l) => l.maxResumableUploadBytes),
  );
  const tagService = createTagService(createTagRepository(db));
  const statsService = createStatsService(createStatsRepository(db));
  const authService = createAuthService(
    createUserRepository(db),
    createSessionRepository(db),
    createApiKeyRepository(db),
    { sessionExpiryMs: limits.sessionExpiryMs },
  );
  return { assetService, uploadService, tagService, statsService, authService, settingsService, events };
}

/**
 * The Core plus the {@link DB} handle it was built over. Returned by
 * {@link createCoreRuntime} so the composition root can share the SAME handle
 * with the plugin loader (to run plugin-owned migrations and give plugins a
 * `ctx.db`) instead of opening a second connection pool.
 */
export interface CoreRuntime {
  core: Core;
  /** The shared Drizzle handle — reused for plugin migrations + `ctx.db`. */
  db: DB;
  /**
   * The shared asset {@link StorageProvider} — surfaced (through Core, not by
   * importing `@bunbooru/storage` in `apps/*`) so the plugin loader can give a
   * plugin a namespaced storage handle (`ctx.storage`) over the same backend.
   */
  storage: StorageProvider;
}

/**
 * Build the Core from runtime config AND expose the underlying {@link DB}.
 *
 * This is the single entry point the API composition root calls. It owns the
 * db/storage → repository → service wiring so callers depend only on
 * `@bunbooru/core`, never on `@bunbooru/db` or `@bunbooru/storage` directly
 * (preserving the `apps → core → …` direction). The `db` is surfaced — through
 * Core, not by importing `@bunbooru/db` in `apps/*` — so the plugin loader can
 * migrate plugin tables and inject `ctx.db` over the same connection.
 */
export function createCoreRuntime(config: CoreConfig): CoreRuntime {
  const db = createDb(config.databaseUrl);
  const storage = createFilesystemStorageProvider({ root: config.storageRoot });
  const core = assembleCore(
    db,
    storage,
    // Staging lives under the (writable) storage root so resumable chunks land
    // on the same host volume as the final assets.
    createFilesystemStaging({ root: join(config.storageRoot, "uploads-staging") }),
    {
      maxUploadBytes: config.maxUploadBytes,
      maxResumableUploadBytes: config.maxResumableUploadBytes,
      requestBodyCeilingBytes: config.requestBodyCeilingBytes,
      sessionExpiryMs: config.sessionExpiryMs,
    },
  );
  return { core, db, storage };
}

/**
 * Build the Core from runtime config. A thin wrapper over
 * {@link createCoreRuntime} for callers that don't need the `db` handle (e.g.
 * existing tests). New composition roots that load plugins should call
 * {@link createCoreRuntime} to share the connection.
 */
export function createCore(config: CoreConfig): Core {
  return createCoreRuntime(config).core;
}
