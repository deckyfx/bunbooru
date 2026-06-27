/**
 * `@bunbooru/storage` — the `StorageProvider` contract.
 *
 * Core never touches the filesystem directly. Filesystem, S3, MinIO, and R2
 * implementations must all satisfy this interface, so new providers require
 * zero Core changes. Concrete implementations land in later PRs.
 */
export interface StorageProvider {
  /** Persist `data` under `key`. */
  store(key: string, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void>;
  /** Remove the object at `key`. */
  delete(key: string): Promise<void>;
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Open a readable stream for the object at `key`. */
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Copy `from` to `to` within the provider. */
  copy(from: string, to: string): Promise<void>;
  /** Move `from` to `to` within the provider. */
  move(from: string, to: string): Promise<void>;
  /** Public URL for the object at `key`, if the provider exposes one. */
  getPublicUrl(key: string): string;
}
