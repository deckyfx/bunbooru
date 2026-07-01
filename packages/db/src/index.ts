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
  type AssetUpdate,
} from "./repositories/asset-repository";
export {
  createUploadSessionRepository,
  type UploadSessionRepository,
} from "./repositories/upload-session-repository";
export {
  createTagRepository,
  type TagRepository,
} from "./repositories/tag-repository";
export {
  createStatsRepository,
  type StatsRepository,
} from "./repositories/stats-repository";
export {
  createUserRepository,
  type UserRepository,
} from "./repositories/user-repository";
export {
  createSessionRepository,
  type SessionRepository,
} from "./repositories/session-repository";
