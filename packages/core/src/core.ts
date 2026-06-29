import { createAssetRepository, createDb, type DB } from "@bunbooru/db";
import { createFilesystemStorageProvider, type StorageProvider } from "@bunbooru/storage";

import { createAssetService, type AssetService } from "./services/asset-service";

/**
 * The assembled Core: the application services the API (and later, plugins via
 * the SDK) compose over. Adding a domain means adding a service here, not a new
 * dependency edge from `apps/*` into `@bunbooru/db` or `@bunbooru/storage`.
 */
export interface Core {
  assetService: AssetService;
}

/** Runtime configuration needed to stand up the Core. */
export interface CoreConfig {
  /** Postgres connection string (e.g. `envConfig.DATABASE_URL`). */
  databaseUrl: string;
  /** Filesystem root under which asset binaries are stored. */
  storageRoot: string;
}

/**
 * Wire the Core over existing {@link DB} and {@link StorageProvider} handles.
 *
 * Separated from {@link createCore} so integration tests can inject a shared
 * connection and a throwaway storage root.
 */
export function assembleCore(db: DB, storage: StorageProvider): Core {
  const assetService = createAssetService(createAssetRepository(db), storage);
  return { assetService };
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
  );
}
