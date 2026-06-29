import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { useNavigate } from "@tanstack/react-router";
import { ImagePlus, Loader2 } from "lucide-react";

import { RatingControl, type Rating } from "../components/rating-control";
import { assetFileUrl } from "../lib/api";
import { useUpdateAsset, type AssetDto } from "../lib/assets";
import { uploadAsset } from "../lib/upload";

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Danbooru-style upload: picking a file (or dropping one) uploads it immediately
 * with a progress bar — no submit button. Once the asset exists, the page swaps
 * to a metadata editor (rating/source now; tags later) bound to that new post.
 */
export function UploadPage() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [asset, setAsset] = useState<AssetDto | null>(null);
  const [deduped, setDeduped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Abort an in-flight upload if the user resets or leaves the page, so an
  // abandoned upload can't finish and create an asset behind their back.
  const abortRef = useRef<AbortController | null>(null);

  // Free the object URL when it's replaced; abort + revoke on unmount.
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);
  useEffect(() => () => abortRef.current?.abort(), []);

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setUploading(false);
    setProgress(0);
    setAsset(null);
    setDeduped(false);
    setError(null);
  }

  async function startUpload(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setAsset(null);
    setProgress(0);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setUploading(true);
    try {
      const result = await uploadAsset(file, { onProgress: setProgress, signal: controller.signal });
      setAsset(result.asset);
      setDeduped(result.deduped);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // user cancelled
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setUploading(false);
      }
    }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the value so picking the SAME file again still fires `change`.
    e.target.value = "";
    if (file) void startUpload(file);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void startUpload(file);
  }

  return (
    <div>
      <h1 className="mb-3 border-b border-line pb-1 text-base font-bold">Upload</h1>

      {asset ? (
        <MetadataEditor asset={asset} previewUrl={previewUrl} deduped={deduped} onReset={reset} />
      ) : (
        <div className="mx-auto max-w-xl space-y-4">
          {/* URL import — deferred to a future 3rd-party-repost plugin. */}
          <div className="rounded border border-line bg-surface p-4 text-center">
            <p className="mb-1 font-bold">Paste URL here</p>
            <input
              type="url"
              disabled
              placeholder="Paste a pixiv link, tweet, etc"
              className="block w-full rounded border border-line bg-bg p-1.5 text-center text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="mt-1 text-[11px] text-muted">
              Importing from external sites lands with a plugin (coming soon).
            </p>
          </div>

          <div className="text-center text-[12px] text-muted">— or —</div>

          {/* Drop / pick — uploads immediately on selection. */}
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded border-2 border-dashed border-line bg-bg text-center text-muted hover:border-link focus-within:border-link focus-within:ring-2 focus-within:ring-link"
          >
            {previewUrl ? (
              <img src={previewUrl} alt="Selected preview" className="h-full w-full object-contain" />
            ) : (
              <span className="flex flex-col items-center gap-2 px-4 text-[12px]">
                <ImagePlus className="h-10 w-10" strokeWidth={1.25} aria-hidden="true" />
                Choose file or drag image here
              </span>
            )}
            <input type="file" accept="image/*" onChange={onInputChange} className="sr-only" />
          </label>

          {uploading ? <ProgressBar value={progress} /> : null}

          {error ? (
            <p className="text-center text-[12px] text-tag-artist">
              {error}{" "}
              <button type="button" onClick={reset} className="underline">
                Try again
              </button>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Upload progress bar (0..1). */
function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="space-y-1" aria-label="Upload progress" role="progressbar" aria-valuenow={pct}>
      <div className="h-2 w-full overflow-hidden rounded bg-line/40">
        <div className="h-full rounded bg-link transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="flex items-center justify-center gap-1 text-[11px] text-muted">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Uploading… {pct}%
      </p>
    </div>
  );
}

/** Stage 2: edit the freshly-created post's metadata (rating/source; tags later). */
function MetadataEditor({
  asset,
  previewUrl,
  deduped,
  onReset,
}: {
  asset: AssetDto;
  previewUrl: string | null;
  deduped: boolean;
  onReset: () => void;
}) {
  const navigate = useNavigate();
  const update = useUpdateAsset(asset.id);
  const [rating, setRating] = useState<Rating>(asset.rating);
  const [source, setSource] = useState(asset.source ?? "");
  // Track the last-persisted values locally — `asset` is the immutable upload
  // result and this component never rehydrates from the cache, so comparing
  // against it would re-PATCH (rating) or never retry (source) after the first edit.
  const [savedRating, setSavedRating] = useState<Rating>(asset.rating);
  const [savedSource, setSavedSource] = useState(asset.source ?? "");

  function changeRating(next: Rating) {
    if (next === savedRating || update.isPending) return;
    const previous = savedRating;
    setRating(next); // optimistic
    update.mutate(
      { rating: next },
      { onSuccess: () => setSavedRating(next), onError: () => setRating(previous) },
    );
  }

  function saveSource() {
    const trimmed = source.trim();
    if (trimmed === savedSource) return; // nothing changed since the last save
    update.mutate(
      { source: trimmed || null },
      { onSuccess: () => setSavedSource(trimmed) },
    );
  }

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="md:w-80 md:shrink-0">
        <div className="flex justify-center rounded border border-line bg-bg p-2">
          <img
            src={previewUrl ?? assetFileUrl(asset.id)}
            alt={`Post ${asset.id}`}
            className="max-h-[60vh] w-auto max-w-full rounded"
          />
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {asset.mimeType} · {formatBytes(asset.sizeBytes)} · {asset.width}×{asset.height}
        </p>
        {deduped ? (
          <p className="mt-1 text-[11px] text-muted">
            This image already existed — you’re editing the existing post.
          </p>
        ) : null}
      </div>

      <div className="flex-1 space-y-4">
        <section>
          <h3 className="mb-1 font-bold">Rating</h3>
          <RatingControl value={rating} onChange={changeRating} disabled={update.isPending} />
        </section>

        <section>
          <h3 className="mb-1 font-bold">Source</h3>
          <div className="flex gap-2">
            <input
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onBlur={saveSource}
              placeholder="https://…"
              className="block w-full max-w-md rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
            />
            <button
              type="button"
              onClick={saveSource}
              disabled={update.isPending}
              className="rounded border border-line px-3 text-[12px] hover:border-link disabled:cursor-not-allowed disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </section>

        <section>
          <h3 className="mb-1 font-bold">Tags</h3>
          <textarea
            rows={3}
            disabled
            placeholder="Tagging coming soon"
            className="block w-full max-w-md rounded border border-line p-2 font-mono text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </section>

        {update.isError ? (
          <p className="text-[12px] text-tag-artist">Couldn’t save changes. Please try again.</p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void navigate({ to: "/posts/$id", params: { id: String(asset.id) } })}
            className="rounded bg-link px-4 py-2 text-white"
          >
            View post »
          </button>
          <button
            type="button"
            onClick={onReset}
            className="rounded border border-line px-4 py-2 hover:border-link"
          >
            Upload another
          </button>
        </div>
      </div>
    </div>
  );
}
