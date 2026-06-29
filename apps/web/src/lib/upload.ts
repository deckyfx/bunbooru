import type { AssetDto } from "@bunbooru/api";

/**
 * Binary upload transport — the ONE place the frontend bypasses Eden Treaty.
 *
 * Eden (and `fetch`) cannot report upload progress, so the file transfer uses
 * XMLHttpRequest to drive a real progress bar. This is a deliberate, narrow
 * exception to the "Eden Treaty for all API calls" rule, scoped to this binary
 * POST; every metadata call (rating/source via PATCH) still goes through Eden.
 * The response is typed manually against the server's {@link AssetDto}.
 *
 * (A future PR swaps this for a resumable chunked client; the call site only
 * depends on this `uploadAsset` signature, so that change stays contained.)
 */
export interface UploadResult {
  asset: AssetDto;
  /** True when an identical image already existed (server replied 200, not 201). */
  deduped: boolean;
}

export interface UploadOptions {
  rating?: AssetDto["rating"];
  source?: string | null;
  /** Progress as a 0..1 fraction of bytes sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** POST a file to `/api/v1/assets` (same-origin) with progress reporting. */
export function uploadAsset(file: File, options: UploadOptions = {}): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (options.rating) form.append("rating", options.rating);
    if (options.source != null) form.append("source", options.source);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/assets");
    xhr.responseType = "json";

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 200 || xhr.status === 201) {
        options.onProgress?.(1);
        resolve({ asset: xhr.response as AssetDto, deduped: xhr.status === 200 });
        return;
      }
      const body = xhr.response as { error?: { message?: string } } | null;
      reject(new Error(body?.error?.message ?? `Upload failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload aborted", "AbortError")));

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}
