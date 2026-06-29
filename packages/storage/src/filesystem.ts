import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { StorageProvider } from "./provider";
import { resolveKeyWithinRoot } from "./resolve-key";

/** Configuration for the filesystem-backed {@link StorageProvider}. */
export interface FilesystemStorageConfig {
  /** Directory under which all objects are stored (created on demand). */
  root: string;
}

/**
 * Filesystem-backed {@link StorageProvider} using Bun's native file APIs.
 *
 * Every key is resolved against `root` and validated to stay inside it, so a
 * malicious *key* like `../../etc/passwd` or an absolute path can never read or
 * write outside the storage root. This confines key-based traversal; it assumes
 * `root` is a directory the app owns — keys are app-generated content paths
 * (e.g. `assets/ab/cd/<sha256>`), never raw user input. Symlinks deliberately
 * planted inside `root` pointing elsewhere are out of scope (that requires FS
 * write access to the root already); add realpath-based checks if an untrusted
 * root is ever introduced.
 *
 * `getPublicUrl` returns `null`: a local filesystem has no inherent public URL —
 * the API serves bytes via its own route (URL minting/expiry stays a transport
 * concern, not storage's).
 *
 * @param config - storage configuration ({@link FilesystemStorageConfig}).
 */
export function createFilesystemStorageProvider(
  config: FilesystemStorageConfig,
): StorageProvider {
  const root = resolve(config.root);
  const resolveKey = (key: string) => resolveKeyWithinRoot(root, key);

  return {
    async store(key, data) {
      const path = resolveKey(key);
      await mkdir(dirname(path), { recursive: true });
      // Split the call so each branch matches a single Bun.write overload; the
      // Response path streams to disk without buffering the whole body.
      if (data instanceof Uint8Array) {
        await Bun.write(path, data);
      } else {
        await Bun.write(path, new Response(data));
      }
    },

    async delete(key) {
      await rm(resolveKey(key), { force: true });
    },

    async exists(key) {
      return Bun.file(resolveKey(key)).exists();
    },

    async stream(key) {
      const file = Bun.file(resolveKey(key));
      if (!(await file.exists())) {
        throw new Error(`storage object not found: ${JSON.stringify(key)}`);
      }
      return file.stream();
    },

    async copy(from, to) {
      // Validate the source first so a rejected escaping key leaves no dirs behind.
      const source = resolveKey(from);
      const target = resolveKey(to);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    },

    async move(from, to) {
      const source = resolveKey(from);
      const target = resolveKey(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    },

    async getPublicUrl() {
      return null;
    },
  };
}
