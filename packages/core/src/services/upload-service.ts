import type { Asset, UploadSessionRepository } from "@bunbooru/db";
import type { StagingStore } from "@bunbooru/storage";

import { UnsupportedMediaError, UploadConflictError, UploadRangeError } from "../errors";
import type { AssetService } from "./asset-service";

/** Abandoned sessions are reclaimed after this long. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Per-key in-process mutex: serializes async work for a given key by chaining
 * each call onto the previous one for that key. Used to make a session's
 * read→write→commit sequence atomic within this process, so two concurrent
 * PATCHes on the same token can't interleave and overwrite each other's staged
 * bytes. Single-process scope only; a multi-instance deployment would also need
 * a DB advisory lock (follow-up). The map entry is dropped once its chain drains
 * so it can't grow without bound.
 */
function createKeyedMutex() {
  const chains = new Map<string, Promise<unknown>>();
  return function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    // Run after the prior holder settles (success or failure both release).
    const run = prior.then(fn, fn);
    // Store a rejection-swallowed tail so a failed call doesn't surface as an
    // unhandled rejection or poison the next waiter; callers still see `run`.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };
}

/** Input to open a resumable upload. */
export interface BeginUploadInput {
  filename: string;
  /** Declared total byte size of the file. */
  size: number;
  mimeType?: string | null;
  uploaderId?: number | null;
}

/** Handle returned when a session is opened. */
export interface UploadBegun {
  token: string;
  offset: number;
  size: number;
}

/** Result of appending a chunk: still receiving, or finalized into an asset. */
export type AppendChunkResult =
  | { status: "incomplete"; offset: number }
  | { status: "complete"; asset: Asset; deduped: boolean };

/**
 * Resumable chunked uploads. Stages chunks to a {@link StagingStore}, tracks the
 * committed offset in an {@link UploadSessionRepository}, and finalizes a
 * completed upload through the normal {@link AssetService.create} pipeline
 * (dedupe → sniff → store → insert → emit). Stays HTTP-agnostic: offset/size
 * violations are thrown as typed errors the API maps to status codes.
 */
export interface UploadService {
  /** Open a session for a file of `size` bytes. */
  begin(input: BeginUploadInput): Promise<UploadBegun>;
  /** Current committed offset + declared size, or null if the session is unknown. */
  offsetOf(token: string): Promise<{ offset: number; size: number } | null>;
  /** Commit `data` at `offset`; finalizes into an asset when it completes the file. */
  appendChunk(token: string, offset: number, data: Uint8Array): Promise<AppendChunkResult>;
  /** Cancel + clean up a session; false if it didn't exist. */
  cancel(token: string): Promise<boolean>;
  /** Reclaim expired sessions and their staging files; returns how many were removed. */
  gcExpired(at?: Date): Promise<number>;
}

/**
 * Build an {@link UploadService}. `now` is injectable so tests can drive the
 * session clock (TTL/GC) deterministically.
 */
export function createUploadService(
  sessions: UploadSessionRepository,
  staging: StagingStore,
  assetService: AssetService,
  maxUploadBytes: number,
  now: () => Date = () => new Date(),
): UploadService {
  // Serializes each session's write+commit so concurrent PATCHes on one token
  // can't corrupt the staged file (see {@link createKeyedMutex}).
  const withSessionLock = createKeyedMutex();

  async function gcExpired(at: Date = now()): Promise<number> {
    const stagingKeys = await sessions.deleteExpired(at);
    await Promise.all(stagingKeys.map((key) => staging.remove(key).catch(() => undefined)));
    return stagingKeys.length;
  }

  return {
    async begin({ filename, size, mimeType, uploaderId }) {
      // Bound the size up front: completion reads the whole staged file into
      // memory, so reject oversized sessions before creating DB/staging state.
      if (!Number.isSafeInteger(size) || size < 1 || size > maxUploadBytes) {
        throw new UploadRangeError(`invalid upload size: ${size}`);
      }
      // Opportunistic, non-blocking sweep of abandoned sessions.
      void gcExpired().catch(() => undefined);

      const token = crypto.randomUUID();
      const createdAt = now();
      await sessions.create({
        token,
        filename,
        mimeType: mimeType ?? null,
        declaredSize: size,
        uploadedSize: 0,
        stagingKey: token, // one staging file per session, keyed by its token
        uploaderId: uploaderId ?? null,
        expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS),
      });
      return { token, offset: 0, size };
    },

    async offsetOf(token) {
      const session = await sessions.findByToken(token);
      return session ? { offset: session.uploadedSize, size: session.declaredSize } : null;
    },

    appendChunk(token, offset, data) {
      // Hold the per-session lock across the whole read→validate→write→commit
      // sequence so a second concurrent PATCH on this token can't pass the same
      // offset check and overwrite our staged bytes before our commit lands.
      return withSessionLock(token, async (): Promise<AppendChunkResult> => {
        const session = await sessions.findByToken(token);
        if (!session) {
          throw new UploadRangeError("unknown or expired upload session");
        }
        if (offset !== session.uploadedSize) {
          // Client is out of sync (double-send or resumed wrong): it must HEAD to
          // re-read the offset and continue from there.
          throw new UploadConflictError(
            `offset mismatch: session is at ${session.uploadedSize}, got ${offset}`,
          );
        }
        const newOffset = offset + data.byteLength;
        if (newOffset > session.declaredSize) {
          throw new UploadRangeError(`chunk would exceed declared size ${session.declaredSize}`);
        }

        // The session lock guarantees we're the only writer for this token, so
        // the write and the compare-and-swap commit happen as one unit; the CAS
        // remains as a cheap cross-process guard.
        await staging.writeChunk(session.stagingKey, offset, data);
        const committed = await sessions.setOffset(token, offset, newOffset);
        if (!committed) {
          // Another writer advanced this session out from under us (only possible
          // across processes); the client must re-HEAD the offset and resume.
          throw new UploadConflictError("offset advanced concurrently; re-sync and retry");
        }

        if (newOffset < session.declaredSize) {
          return { status: "incomplete", offset: newOffset };
        }

        // Complete: finalize through the asset pipeline. Clean up only on success
        // or a permanent failure (the assembled bytes aren't a decodable image →
        // UnsupportedMediaError → 415). A transient failure (DB/storage hiccup)
        // leaves the staged bytes + session intact so the upload can be retried
        // rather than forcing a full re-upload; abandoned ones expire via GC.
        let permanent = true;
        try {
          // Finalize from the staged file as a streaming source — hashes, sniffs,
          // and stores without reading the whole (up to multi-GB) file into memory.
          const { asset, deduped } = await assetService.createFromSource(
            staging.open(session.stagingKey),
            { uploaderId: session.uploaderId },
          );
          return { status: "complete", asset, deduped };
        } catch (error) {
          permanent = error instanceof UnsupportedMediaError;
          throw error;
        } finally {
          if (permanent) {
            await sessions.delete(token).catch(() => undefined);
            await staging.remove(session.stagingKey).catch(() => undefined);
          }
        }
      });
    },

    cancel(token) {
      // Serialize cancellation under the same per-session lock as appendChunk so
      // it can't interleave with an in-flight append (e.g. delete the row or wipe
      // the staged file while a chunk write/commit is mid-flight). It runs only
      // between appends, never during one.
      return withSessionLock(token, async () => {
        const session = await sessions.findByToken(token);
        if (!session) return false;
        // Delete the DB row first: if removing the staged file fails, we must not
        // leave a session advertising a resumable upload whose bytes are gone.
        await sessions.delete(token);
        await staging.remove(session.stagingKey).catch(() => undefined);
        return true;
      });
    },

    gcExpired,
  };
}
