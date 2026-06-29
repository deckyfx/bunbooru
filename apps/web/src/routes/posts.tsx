import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { Link } from "@tanstack/react-router";

import { DropdownMenu } from "../components/menu/dropdown-menu";
import { SearchBox } from "../components/popover/search-box";
import { TagGroups } from "../components/tags/tag-groups";
import { TagRow } from "../components/tags/tag-row";
import { AssetImage } from "../components/asset-image";
import { assetFileUrl } from "../lib/api";
import { useAssetsPage } from "../lib/assets";
import { lookupTag } from "../lib/tags";
import { MAX_COLUMNS, MIN_COLUMNS, useGalleryStore } from "../stores/gallery";

/** Placeholder sidebar tags (a live tag index lands with the search thrust). */
const SIDEBAR_TAGS = [
  "original",
  "hatsune_miku",
  "kantai_collection",
  "wlop",
  "1girl",
  "solo",
  "long_hair",
  "highres",
  "absurdres",
];

const RELATED_TAGS = [...new Set(SIDEBAR_TAGS.flatMap((name) => lookupTag(name).related))]
  .filter((name) => !SIDEBAR_TAGS.includes(name))
  .slice(0, 12);

const COLUMN_CHOICES = Array.from(
  { length: MAX_COLUMNS - MIN_COLUMNS + 1 },
  (_, i) => MIN_COLUMNS + i,
);

/** A window of page numbers centred on the current page. */
function pageWindow(current: number, total: number, span = 5): number[] {
  if (total < 1) return [];
  const end = Math.min(total, Math.max(current + 2, span));
  const start = Math.max(1, end - span + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export function PostsPage() {
  const columns = useGalleryStore((s) => s.columns);
  const setColumns = useGalleryStore((s) => s.setColumns);
  const boardMode = useGalleryStore((s) => s.boardMode);
  const setBoardMode = useGalleryStore((s) => s.setBoardMode);

  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useAssetsPage(page);
  const classic = boardMode === "classic";
  const pageCount = data?.pageCount ?? 0;

  // If the total shrinks (e.g. deletions) so the current page no longer exists,
  // snap back to the last valid page — otherwise we'd render "No posts yet" for
  // an out-of-range page with no active pagination item.
  useEffect(() => {
    if (pageCount > 0 && page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  // Classic = uniform square grid; fluid = masonry (mixed aspect ratios).
  const gridStyle: CSSProperties = classic
    ? { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: "0.5rem" }
    : { columnCount: columns, columnGap: "0.5rem" };

  return (
    <div className="flex gap-4">
      <aside className="w-64 shrink-0 space-y-4">
        <SearchBox placeholder="Search" className="w-full" />
        <section>
          <h3 className="mb-1 font-bold">Tags</h3>
          <TagGroups names={SIDEBAR_TAGS} />
        </section>
        <section>
          <h3 className="mb-1 font-bold">Related Tags</h3>
          <ul className="space-y-0.5">
            {RELATED_TAGS.map((name) => (
              <TagRow key={name} name={name} />
            ))}
          </ul>
        </section>
      </aside>

      <section className="min-w-0 flex-1">
        <nav className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-2 text-[12px]">
          <span className="font-bold">Posts</span>
          {data ? <span className="text-muted">{data.total} total</span> : null}

          <div className="ml-auto flex items-center gap-3">
            <DropdownMenu label="Size">
              <div className="mb-1 text-muted">Columns</div>
              <div className="flex items-center gap-1">
                {COLUMN_CHOICES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setColumns(n)}
                    className={`h-6 w-6 rounded border text-[11px] ${
                      n === columns
                        ? "border-link bg-link text-white"
                        : "border-line hover:border-link"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </DropdownMenu>

            <DropdownMenu label="Options">
              <div className="mb-1 text-muted">Layout</div>
              <div className="flex gap-1">
                <ModeButton active={!classic} onClick={() => setBoardMode("fluid")}>
                  Fluid
                </ModeButton>
                <ModeButton active={classic} onClick={() => setBoardMode("classic")}>
                  Classic
                </ModeButton>
              </div>
            </DropdownMenu>

            <Link to="/uploads/new" className="hover:underline">
              Upload
            </Link>
          </div>
        </nav>

        {isLoading ? (
          <p className="py-12 text-center text-muted">Loading posts…</p>
        ) : isError ? (
          <div className="py-12 text-center">
            <p className="mb-2 font-bold">Couldn’t load posts</p>
            <button type="button" onClick={() => void refetch()} className="hover:underline">
              Retry
            </button>
          </div>
        ) : !data || data.assets.length === 0 ? (
          <div className="py-12 text-center">
            <p className="mb-2 font-bold">No posts yet</p>
            <Link to="/uploads/new" className="text-link hover:underline">
              Upload the first one »
            </Link>
          </div>
        ) : (
          <div style={gridStyle}>
            {data.assets.map((asset) => (
              <Link
                key={asset.id}
                to="/posts/$id"
                params={{ id: String(asset.id) }}
                className={`relative block w-full overflow-hidden rounded border-2 border-line hover:border-link ${
                  classic ? "" : "mb-2 break-inside-avoid"
                }`}
                style={{ aspectRatio: classic ? "1 / 1" : `${asset.width} / ${asset.height}` }}
              >
                <AssetImage
                  src={assetFileUrl(asset.id)}
                  alt={`Post ${asset.id}`}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </Link>
            ))}
          </div>
        )}

        {pageCount > 1 ? (
          <div className="mt-4 flex items-center justify-center gap-1 text-[12px]">
            <PageButton disabled={page === 1} onClick={() => setPage(1)}>
              « First
            </PageButton>
            <PageButton disabled={page === 1} onClick={() => setPage(page - 1)}>
              ‹ Prev
            </PageButton>
            {pageWindow(page, pageCount).map((p) => (
              <button
                key={p}
                type="button"
                aria-current={p === page ? "page" : undefined}
                onClick={() => setPage(p)}
                className={
                  p === page
                    ? "rounded bg-link px-2 py-1 text-white"
                    : "rounded px-2 py-1 hover:underline"
                }
              >
                {p}
              </button>
            ))}
            <PageButton disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
              Next ›
            </PageButton>
            <PageButton disabled={page >= pageCount} onClick={() => setPage(pageCount)}>
              Last »
            </PageButton>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded border px-2 py-0.5 ${
        active ? "border-link bg-link text-white" : "border-line hover:border-link"
      }`}
    >
      {children}
    </button>
  );
}

function PageButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-line px-2 py-1 hover:border-link disabled:cursor-not-allowed disabled:text-muted disabled:hover:border-line"
    >
      {children}
    </button>
  );
}
