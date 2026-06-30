import { join } from "node:path";

import {
  createAssetRepository,
  createDb,
  createTagRepository,
  createUploadSessionRepository,
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
  /** Typed pub/sub bus — Core emits domain events (e.g. `asset.created`); plugins subscribe. */
  events: CoreEvents;
}

/** Runtime configuration needed to stand up the Core. */
export interface CoreConfig {
  /** Postgres connection string (e.g. `envConfig.DATABASE_URL`). */
  databaseUrl: string;
  /** Filesystem root under which asset binaries are stored. */
  storageRoot: string;
  /** Reject resumable uploads larger than this many bytes (bounded up front in `begin`). */
  maxResumableUploadBytes: number;
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
  maxResumableUploadBytes: number,
): Core {
  const events = createCoreEvents();
  const assetService = createAssetService(createAssetRepository(db), storage, events);
  const uploadService = createUploadService(
    createUploadSessionRepository(db),
    staging,
    assetService,
    maxResumableUploadBytes,
  );
  const tagService = createTagService(createTagRepository(db));
  return { assetService, uploadService, tagService, events };
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
    config.maxResumableUploadBytes,
  );
}
