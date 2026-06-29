import type { AssetDto } from "@bunbooru/api";

/**
 * Binary upload transport — the ONE place the frontend bypasses Eden Treaty.
 *
 * Uploads are **resumable + chunked**: open a session (`POST /uploads`), then
 * `PATCH` ~5 MiB slices at increasing offsets until the file completes and the
 * server finalizes it into an asset. XHR drives a real progress bar (Eden/fetch
 * can't report upload progress); on a transient chunk error we re-`HEAD` the
 * server's committed offset and resume. This is a deliberate, narrow exception
 * to the "Eden Treaty for all API calls" rule, scoped to this transport; every
 * metadata call (rating/source via PATCH) still goes through Eden. The responses
 * are typed manually against the server's {@link AssetDto}.
 */
export interface UploadResult {
  asset: AssetDto;
  /** True when an identical image already existed (server replied 200, not 201). */
  deduped: boolean;
}

export interface UploadOptions {
  /** Progress as a 0..1 fraction of bytes committed. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB per PATCH
const MAX_CHUNK_RETRIES = 3;

/** Upload a file resumably; resolves with the finalized asset. */
export async function uploadAsset(file: File, options: UploadOptions = {}): Promise<UploadResult> {
  const { onProgress, signal } = options;
  const session = await beginSession(file, signal);
  let offset = session.offset;
  let attempts = 0;

  try {
    while (offset < file.size) {
      throwIfAborted(signal);
      const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      try {
        const result = await patchChunk(session.token, offset, slice, file.size, onProgress, signal);
        attempts = 0;
        if (result.kind === "complete") return result.value;
        offset = result.offset;
      } catch (error) {
        if (isAbort(error)) throw error;
        if (++attempts > MAX_CHUNK_RETRIES) throw error;
        // Re-sync the committed offset from the server, then retry from there.
        const serverOffset = await headOffset(session.token, signal).catch((resumeError: unknown) => {
          if (isAbort(resumeError)) throw resumeError; // don't mask a user abort as a retry
          return null;
        });
        if (serverOffset === null) throw error; // session gone — unrecoverable
        offset = serverOffset;
        await delay(300 * attempts);
      }
    }
    // The completing chunk returns the asset above; reaching here means the
    // server never finalized (shouldn't happen for a non-empty file).
    throw new Error("Upload finished but the server did not finalize it.");
  } catch (error) {
    // Any terminal failure after the session exists: the token is about to be
    // lost to the caller, so best-effort cancel it server-side (abort or not).
    cancelSession(session.token);
    throw error;
  }
}

interface BegunSession {
  token: string;
  offset: number;
  size: number;
}

async function beginSession(file: File, signal?: AbortSignal): Promise<BegunSession> {
  const res = await fetch("/api/v1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      mimeType: file.type || undefined,
    }),
    signal,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not start the upload."));
  return (await res.json()) as BegunSession;
}

type ChunkOutcome =
  | { kind: "incomplete"; offset: number }
  | { kind: "complete"; value: UploadResult };

function patchChunk(
  token: string,
  offset: number,
  slice: Blob,
  totalSize: number,
  onProgress: ((fraction: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ChunkOutcome> {
  return new Promise<ChunkOutcome>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", `/api/v1/uploads/${token}`);
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.responseType = "json";

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.((offset + event.loaded) / totalSize);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 204) {
        const next = Number(xhr.getResponseHeader("Upload-Offset"));
        const committed = Number.isFinite(next) ? next : offset + slice.size;
        onProgress?.(committed / totalSize);
        resolve({ kind: "incomplete", offset: committed });
        return;
      }
      if (xhr.status === 200 || xhr.status === 201) {
        onProgress?.(1);
        resolve({ kind: "complete", value: { asset: xhr.response as AssetDto, deduped: xhr.status === 200 } });
        return;
      }
      const body = xhr.response as { error?: { message?: string } } | null;
      reject(new Error(body?.error?.message ?? `Chunk upload failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload aborted", "AbortError")));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(slice);
  });
}

/** Read the server's committed offset for resume, or null if the session is gone. */
async function headOffset(token: string, signal?: AbortSignal): Promise<number | null> {
  const res = await fetch(`/api/v1/uploads/${token}`, { method: "HEAD", signal });
  if (!res.ok) return null;
  const offset = Number(res.headers.get("Upload-Offset"));
  return Number.isFinite(offset) ? offset : null;
}

/** Best-effort cancel so the server can drop the staged bytes. */
function cancelSession(token: string): void {
  void fetch(`/api/v1/uploads/${token}`, { method: "DELETE" }).catch(() => undefined);
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `${fallback} (HTTP ${res.status})`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
