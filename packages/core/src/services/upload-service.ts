import type { Asset, UploadSessionRepository } from "@bunbooru/db";
import type { StagingStore } from "@bunbooru/storage";

import { UploadConflictError, UploadRangeError } from "../errors";
import type { AssetService } from "./asset-service";

/** Abandoned sessions are reclaimed after this long. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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

    async appendChunk(token, offset, data) {
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

      // The positional write is idempotent, so a losing concurrent writer wrote
      // the same range harmlessly; the compare-and-swap below is what actually
      // serializes the commit.
      await staging.writeChunk(session.stagingKey, offset, data);
      const committed = await sessions.setOffset(token, offset, newOffset);
      if (!committed) {
        // Another PATCH advanced this session between our read and write — the
        // client must re-HEAD the offset and resume.
        throw new UploadConflictError("offset advanced concurrently; re-sync and retry");
      }

      if (newOffset < session.declaredSize) {
        return { status: "incomplete", offset: newOffset };
      }

      // Complete: finalize through the asset pipeline, then clean up the session
      // and staging file whether reading/finalizing succeeds or throws (e.g. the
      // assembled bytes aren't a decodable image → UnsupportedMediaError → 415).
      try {
        const bytes = await staging.readAll(session.stagingKey);
        const { asset, deduped } = await assetService.create({
          bytes,
          uploaderId: session.uploaderId,
        });
        return { status: "complete", asset, deduped };
      } finally {
        await sessions.delete(token).catch(() => undefined);
        await staging.remove(session.stagingKey).catch(() => undefined);
      }
    },

    async cancel(token) {
      const session = await sessions.findByToken(token);
      if (!session) return false;
      // Delete the DB row first: if removing the staged file fails, we must not
      // leave a session advertising a resumable upload whose bytes are gone.
      await sessions.delete(token);
      await staging.remove(session.stagingKey).catch(() => undefined);
      return true;
    },

    gcExpired,
  };
}
