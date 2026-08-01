import type { StorageProvider, StoredObject } from "@bunbooru/core";

/**
 * Wrap a {@link StorageProvider} so every key is transparently prefixed with
 * `plugins/<id>/`, giving a plugin an isolated slice of the shared store: it
 * passes plain keys (e.g. `<sha>.webp`) and can neither read nor clobber Core's
 * `assets/…` objects nor another plugin's namespace. `list()` prefixes the
 * search and strips the namespace back off returned keys, so the view is fully
 * plugin-local. This is what the loader injects as `ctx.storage`.
 */
export function namespacedStorage(inner: StorageProvider, namespace: string): StorageProvider {
  // Exactly one trailing slash, so `key("a")` → `plugins/id/a` (not `plugins/ida`).
  const prefix = namespace.endsWith("/") ? namespace : `${namespace}/`;
  const toInner = (key: string): string => `${prefix}${key}`;
  const fromInner = (key: string): string => (key.startsWith(prefix) ? key.slice(prefix.length) : key);

  const wrapped: StorageProvider = {
    store: (key, data) => inner.store(toInner(key), data),
    delete: (key) => inner.delete(toInner(key)),
    exists: (key) => inner.exists(toInner(key)),
    statModifiedAt: (key) => inner.statModifiedAt(toInner(key)),
    stream: (key) => inner.stream(toInner(key)),
    copy: (from, to) => inner.copy(toInner(from), toInner(to)),
    move: (from, to) => inner.move(toInner(from), toInner(to)),
    getPublicUrl: (key) => inner.getPublicUrl(toInner(key)),
    async *list(searchPrefix?: string): AsyncIterable<StoredObject> {
      // No prefix → list the whole namespace; otherwise scope within it.
      const innerPrefix = searchPrefix === undefined ? prefix : toInner(searchPrefix);
      for await (const object of inner.list(innerPrefix)) {
        yield { ...object, key: fromInner(object.key) };
      }
    },
  };

  // `ingestLocalFile` is optional on the contract — only expose it when the
  // backing provider supports it, so the wrapped provider mirrors its capabilities.
  if (inner.ingestLocalFile) {
    const ingest = inner.ingestLocalFile.bind(inner);
    wrapped.ingestLocalFile = (localPath, key) => ingest(localPath, toInner(key));
  }

  return wrapped;
}
