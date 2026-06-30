/** A stored object enumerated by {@link StorageProvider.list}. */
export interface StoredObject {
  /** The object's storage key. */
  key: string;
  /** Last-modified time, so callers can apply an age/grace-period filter. */
  modifiedAt: Date;
}

/**
 * The `StorageProvider` contract.
 *
 * Core never touches the filesystem directly. Filesystem, S3, MinIO, and R2
 * implementations must all satisfy this interface, so new providers require zero
 * Core changes. Kept in its own module so concrete providers can depend on the
 * contract without importing the package barrel (avoids an import cycle).
 */
export interface StorageProvider {
  /**
   * Persist `data` under `key`. Prefer a {@link Blob} (e.g. a file-backed
   * `Bun.file()`) for large payloads — providers stream it to disk/remote
   * without buffering the whole thing in memory. A raw `ReadableStream` is also
   * accepted; pass `someFileBlob` rather than `someFileBlob.stream()` so the
   * provider can use the most efficient native path.
   */
  store(key: string, data: Blob | ReadableStream<Uint8Array> | Uint8Array): Promise<void>;
  /** Remove the object at `key`. */
  delete(key: string): Promise<void>;
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /**
   * Current last-modified time of the object at `key`, or `null` if it's gone.
   * Lets a sweep re-confirm an object's age immediately before deleting it (the
   * value from {@link list} may be stale if the key was rewritten meanwhile).
   */
  statModifiedAt(key: string): Promise<Date | null>;
  /**
   * Enumerate stored objects, optionally restricted to those whose key starts
   * with `prefix`. Async-iterable so a large store streams rather than buffering
   * every key. Used by age-based sweeps (e.g. orphan-blob GC); `modifiedAt`
   * lets callers apply a grace period so freshly-written objects aren't touched.
   */
  list(prefix?: string): AsyncIterable<StoredObject>;
  /** Open a readable stream for the object at `key`. */
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Copy `from` to `to` within the provider. */
  copy(from: string, to: string): Promise<void>;
  /** Move `from` to `to` within the provider. */
  move(from: string, to: string): Promise<void>;
  /**
   * Optionally ingest an existing **local file** (an absolute path the app owns,
   * e.g. a finalized upload-staging file) as the object at `key`, *consuming* the
   * source. A same-filesystem provider can implement this as a rename (no copy) —
   * the fast path for large uploads. Providers that can't (e.g. S3 from a local
   * file) omit it; callers detect support and fall back to `store`. `localPath`
   * is trusted internal input (not a user key); `key` is still confined to the
   * store. Implementations must remove the source on success.
   */
  ingestLocalFile?(localPath: string, key: string): Promise<void>;
  /**
   * Public URL for the object at `key`, or `null` when the provider exposes
   * none (e.g. a private filesystem backend). Async so providers can mint
   * signed/expiring URLs without breaking `plugin-sdk` consumers.
   */
  getPublicUrl(key: string): Promise<string | null>;
}
