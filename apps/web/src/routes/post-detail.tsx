import { useEffect, useState } from "react";

import { Link, useParams } from "@tanstack/react-router";
import { Download } from "lucide-react";

import { AssetImage } from "../components/asset-image";
import { RatingControl, type Rating } from "../components/rating-control";
import { SearchBox } from "../components/popover/search-box";
import { assetFileUrl } from "../lib/api";
import { useAsset, useUpdateAsset, type AssetDto } from "../lib/assets";

/** ISO timestamp → `YYYY-MM-DD`. Tolerates a string or Date so a stray value
 *  never crashes the page. */
function formatDate(value: string | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

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

export function PostDetailPage() {
  const { id } = useParams({ from: "/posts/$id" });
  // Validate the raw segment as plain decimal digits: `Number("1e2")`/`"0x10"`
  // would otherwise coerce to a different, valid-looking id and fetch the wrong
  // asset. Require a safe integer so it round-trips through the API unchanged.
  const validId = /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
  const postId = validId ? Number(id) : 0;

  const { data: asset, isLoading, isError } = useAsset(postId);

  if (!validId) {
    return (
      <NotFound id={id} reason={`“${id}” is not a valid post id.`} />
    );
  }

  return (
    <div className="flex gap-4">
      <aside className="w-64 shrink-0 space-y-4">
        <SearchBox placeholder="Search" className="w-full" />

        <div>
          <h3 className="mb-1 font-bold">Tags</h3>
          <p className="text-[12px] text-muted">No tags yet.</p>
        </div>

        {asset ? (
          <AssetInfo key={asset.id} asset={asset} />
        ) : (
          <div>
            <h3 className="mb-1 font-bold">Information</h3>
            <dl className="space-y-0.5 text-[12px]">
              <Info label="ID" value={`#${postId}`} />
            </dl>
          </div>
        )}
      </aside>

      <section className="min-w-0 flex-1">
        <div className="mb-2 text-[12px]">
          <Link to="/posts" className="hover:underline">
            « Back to posts
          </Link>
        </div>

        {isLoading ? (
          <div className="flex justify-center rounded border border-line bg-bg p-8 text-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex justify-center rounded border border-line bg-bg p-8 text-muted">
            Couldn’t load this post right now. Please try again.
          </div>
        ) : !asset ? (
          <NotFound id={id} reason="This post doesn’t exist or its file is missing." inline />
        ) : (
          <>
            <div className="flex justify-center rounded border border-line bg-bg p-3">
              <AssetImage
                src={assetFileUrl(asset.id)}
                alt={`Post ${asset.id}`}
                className="max-h-[80vh] w-auto max-w-full rounded"
                style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
              <a
                href={assetFileUrl(asset.id)}
                download
                className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:border-link"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function NotFound({ id, reason, inline }: { id: string; reason: string; inline?: boolean }) {
  return (
    <div className={inline ? "py-12 text-center" : "py-12 text-center"}>
      <p className="mb-2 font-bold">Post not found</p>
      <p className="mb-4 text-muted">{reason}</p>
      <Link to="/posts" className="hover:underline">
        « Back to posts
      </Link>
      <span className="sr-only">Requested id: {id}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-right">{value}</dd>
    </div>
  );
}

/** Information panel with an inline editor for the mutable fields (rating/source). */
function AssetInfo({ asset }: { asset: AssetDto }) {
  const update = useUpdateAsset(asset.id);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState<Rating>(asset.rating);
  const [source, setSource] = useState(asset.source ?? "");

  // Re-sync local fields whenever the asset refetches (e.g. after a save) or its
  // identity changes; drop out of edit mode so stale edits can't carry to another
  // post. (The parent also remounts via key={asset.id}, but this is belt-and-braces.)
  useEffect(() => {
    setRating(asset.rating);
    setSource(asset.source ?? "");
    setEditing(false);
  }, [asset.id, asset.rating, asset.source]);

  async function save() {
    try {
      await update.mutateAsync({ rating, source: source.trim() || null });
      setEditing(false);
    } catch {
      // `update.isError` drives the inline error message; stay in edit mode.
    }
  }

  function cancel() {
    update.reset(); // drop any prior error so reopening starts clean
    setRating(asset.rating);
    setSource(asset.source ?? "");
    setEditing(false);
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-bold">Information</h3>
        {editing ? null : (
          <button
            type="button"
            onClick={() => {
              update.reset();
              setEditing(true);
            }}
            className="text-[11px] text-link hover:underline"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2 text-[12px]">
          <div>
            <div className="mb-1 text-muted">Rating</div>
            <RatingControl value={rating} onChange={setRating} disabled={update.isPending} />
          </div>
          <div>
            <div className="mb-1 text-muted">Source</div>
            <input
              type="url"
              disabled={update.isPending}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://…"
              className="block w-full rounded border border-line p-1 outline-none focus:border-link disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          {update.isError ? <p className="text-tag-artist">Couldn’t save. Please try again.</p> : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={update.isPending}
              className="rounded bg-link px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={update.isPending}
              className="rounded border border-line px-3 py-1 hover:border-link"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl className="space-y-0.5 text-[12px]">
          <Info label="ID" value={`#${asset.id}`} />
          <Info label="Size" value={`${asset.width} × ${asset.height}`} />
          <Info label="File" value={`${asset.mimeType} · ${formatBytes(asset.sizeBytes)}`} />
          <Info label="Rating" value={asset.rating} />
          <Info label="Posted" value={formatDate(asset.createdAt)} />
          <Info label="Source" value={asset.source ?? "—"} />
        </dl>
      )}
    </div>
  );
}
