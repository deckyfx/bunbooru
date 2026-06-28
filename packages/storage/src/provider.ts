/**
 * The `StorageProvider` contract.
 *
 * Core never touches the filesystem directly. Filesystem, S3, MinIO, and R2
 * implementations must all satisfy this interface, so new providers require zero
 * Core changes. Kept in its own module so concrete providers can depend on the
 * contract without importing the package barrel (avoids an import cycle).
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
  /**
   * Public URL for the object at `key`, or `null` when the provider exposes
   * none (e.g. a private filesystem backend). Async so providers can mint
   * signed/expiring URLs without breaking `plugin-sdk` consumers.
   */
  getPublicUrl(key: string): Promise<string | null>;
}
