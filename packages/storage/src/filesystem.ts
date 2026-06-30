import { copyFile, mkdir, rename, rm, unlink } from "node:fs/promises";
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
      // Bun.write streams a Blob (incl. a file-backed `Bun.file()`) or a
      // TypedArray to disk natively, without holding the whole payload in JS —
      // this is the path large resumable uploads finalize through. A raw
      // ReadableStream is wrapped to match a Bun.write overload; note that
      // wrapping a *file-backed* stream this way can stall, which is exactly why
      // callers pass the Blob itself (above), not `blob.stream()`.
      if (data instanceof Blob || data instanceof Uint8Array) {
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

    async statModifiedAt(key) {
      const file = Bun.file(resolveKey(key));
      return (await file.exists()) ? new Date(file.lastModified) : null;
    },

    async *list(prefix = "") {
      // Walk files under `root` matching the prefix; keys are paths relative to
      // `root` (so they round-trip back through resolveKey). `**/*` is files-only
      // by default. A file deleted between scan and stat yields lastModified 0,
      // which an age filter treats as old — harmless, since delete is idempotent.
      const glob = new Bun.Glob(`${prefix}**/*`);
      for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
        yield { key: rel, modifiedAt: new Date(Bun.file(resolve(root, rel)).lastModified) };
      }
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

    async ingestLocalFile(localPath, key) {
      const target = resolveKey(key);
      await mkdir(dirname(target), { recursive: true });
      try {
        // Same filesystem → atomic rename, no copy (the whole point).
        await rename(localPath, target);
      } catch (error) {
        // Cross-device (EXDEV): rename can't span filesystems, so fall back to a
        // copy + remove of the source to preserve the "consumes the source" contract.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        try {
          await copyFile(localPath, target);
          await unlink(localPath);
        } catch (fallbackError) {
          // Don't leave a half-committed object: if the copy landed but the
          // source removal failed, roll the target back so callers see a clean
          // failure (no orphan blob at `key`).
          await rm(target, { force: true });
          throw fallbackError;
        }
      }
    },

    async getPublicUrl() {
      return null;
    },
  };
}
