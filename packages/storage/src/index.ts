/**
 * `@bunbooru/storage` — the `StorageProvider` contract and its implementations.
 *
 * Core never touches the filesystem directly; it depends only on the
 * `StorageProvider` interface, so new backends require zero Core changes.
 */
export const STORAGE_PACKAGE = "@bunbooru/storage" as const;

export type { StorageProvider } from "./provider";
export {
  createFilesystemStorageProvider,
  type FilesystemStorageConfig,
} from "./filesystem";
export {
  createFilesystemStaging,
  type FilesystemStagingConfig,
  type StagingStore,
} from "./staging";
