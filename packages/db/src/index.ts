/**
 * `@bunbooru/db` — Drizzle schema, the connection factory, and migrations.
 *
 * The only layer permitted to execute SQL. Repositories (in `@bunbooru/core`)
 * build on the handle returned by {@link createDb}; nothing here knows HTTP.
 */
export const DB_PACKAGE = "@bunbooru/db" as const;

export * from "./schema";
export { createDb } from "./client";
export type { DB } from "./client";
export {
  createAssetRepository,
  type AssetPage,
  type AssetRepository,
} from "./repositories/asset-repository";
