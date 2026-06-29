import { Link, useParams } from "@tanstack/react-router";
import { Download } from "lucide-react";

import { SearchBox } from "../components/popover/search-box";
import { assetFileUrl } from "../lib/api";
import { useAsset } from "../lib/assets";

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
  const postId = Number(id);
  const validId = Number.isInteger(postId) && postId >= 1;

  const { data: asset, isLoading, isError } = useAsset(validId ? postId : 0);

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

        <div>
          <h3 className="mb-1 font-bold">Information</h3>
          <dl className="space-y-0.5 text-[12px]">
            <Info label="ID" value={`#${postId}`} />
            {asset ? (
              <>
                <Info label="Size" value={`${asset.width} × ${asset.height}`} />
                <Info label="File" value={`${asset.mimeType} · ${formatBytes(asset.sizeBytes)}`} />
                <Info label="Rating" value={asset.rating} />
                <Info label="Posted" value={asset.createdAt.slice(0, 10)} />
                <Info label="Source" value={asset.source ?? "—"} />
              </>
            ) : null}
          </dl>
        </div>
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
              <img
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
