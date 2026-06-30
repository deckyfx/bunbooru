import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { resolveKeyWithinRoot } from "./resolve-key";

/**
 * A scratch area for assembling resumable uploads. Deliberately separate from
 * the asset {@link StorageProvider}: staging is always local + temporary (chunks
 * positional-written to a file), while the final asset store may be remote
 * (S3/R2). The Core's `UploadService` writes chunks here, then reads the whole
 * file back to finalize through the normal asset pipeline.
 */
export interface StagingStore {
  /** Write `data` at byte `offset` in the staging object `key` (creates it on first write). */
  writeChunk(key: string, offset: number, data: Uint8Array): Promise<void>;
  /** Read the fully-assembled staging object back as bytes. */
  readAll(key: string): Promise<Uint8Array>;
  /** Delete a staging object (no-op if already gone). */
  remove(key: string): Promise<void>;
}

export interface FilesystemStagingConfig {
  /** Directory under which staging files live (created on demand). */
  root: string;
}

/** Build a local-filesystem {@link StagingStore}. */
export function createFilesystemStaging(config: FilesystemStagingConfig): StagingStore {
  const root = resolve(config.root);
  const resolveKey = (key: string) => resolveKeyWithinRoot(root, key);

  return {
    async writeChunk(key, offset, data) {
      const path = resolveKey(key);
      await mkdir(dirname(path), { recursive: true });
      // O_CREAT|O_WRONLY: create the file if missing, never truncate, and
      // positional-write the chunk at `offset`. Concurrent writers to the same
      // key are NOT serialized here — the caller (UploadService) holds a
      // per-session lock so only one writer touches a given staging object at a
      // time; this layer just places bytes at a position.
      const handle = await open(path, constants.O_CREAT | constants.O_WRONLY);
      try {
        // FileHandle.write may short-write, so loop until the whole chunk lands
        // at the right position — a truncated write would desync the staged file
        // from the session's committed offset.
        let written = 0;
        while (written < data.byteLength) {
          const { bytesWritten } = await handle.write(
            data,
            written,
            data.byteLength - written,
            offset + written,
          );
          if (bytesWritten === 0) throw new Error("staging write made no progress");
          written += bytesWritten;
        }
      } finally {
        await handle.close();
      }
    },

    async readAll(key) {
      return Bun.file(resolveKey(key)).bytes();
    },

    async remove(key) {
      await rm(resolveKey(key), { force: true });
    },
  };
}
