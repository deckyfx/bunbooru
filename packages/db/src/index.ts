/**
 * `@bunbooru/db` — Drizzle schema, the connection factory, repositories, and
 * migrations.
 *
 * The only layer permitted to execute SQL: repositories live here and expose
 * intent-named data access over the handle from {@link createDb}. Services (in
 * `@bunbooru/core`) compose these repositories; nothing here knows HTTP.
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
