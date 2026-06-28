import { createAssetRepository, createDb, type DB } from "@bunbooru/db";

import { createAssetService, type AssetService } from "./services/asset-service";

/**
 * The assembled Core: the application services the API (and later, plugins via
 * the SDK) compose over. Adding a domain means adding a service here, not a new
 * dependency edge from `apps/*` into `@bunbooru/db`.
 */
export interface Core {
  assetService: AssetService;
}

/** Runtime configuration needed to stand up the Core. */
export interface CoreConfig {
  /** Postgres connection string (e.g. `envConfig.DATABASE_URL`). */
  databaseUrl: string;
}

/**
 * Wire the Core over an existing {@link DB} handle.
 *
 * Separated from {@link createCore} so integration tests can share one
 * connection across the repository and the assembled services.
 */
export function assembleCore(db: DB): Core {
  const assetService = createAssetService(createAssetRepository(db));
  return { assetService };
}

/**
 * Build the Core from runtime config — the single entry point the API
 * composition root calls. It owns the db→repository→service wiring so callers
 * depend only on `@bunbooru/core`, never on `@bunbooru/db` directly (preserving
 * the `apps → core → db` dependency direction).
 */
export function createCore(config: CoreConfig): Core {
  return assembleCore(createDb(config.databaseUrl));
}
