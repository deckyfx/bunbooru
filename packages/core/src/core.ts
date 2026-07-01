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
 * Build the Core from runtime config — the single entry point the API
 * composition root calls. It owns the db/storage → repository → service wiring
 * so callers depend only on `@bunbooru/core`, never on `@bunbooru/db` or
 * `@bunbooru/storage` directly (preserving the `apps → core → …` direction).
 */
export function createCore(config: CoreConfig): Core {
  return assembleCore(
    createDb(config.databaseUrl),
    createFilesystemStorageProvider({ root: config.storageRoot }),
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
}
