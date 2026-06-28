import { type CSSProperties, type ReactNode, useState } from "react";

import { Link } from "@tanstack/react-router";
import { ChevronUp, Heart } from "lucide-react";

import { DropdownMenu } from "../components/menu/dropdown-menu";
import { HoverPopover } from "../components/popover/hover-popover";
import { PostTagsCard } from "../components/popover/post-tags-card";
import { SearchBox } from "../components/popover/search-box";
import { TagGroups } from "../components/tags/tag-groups";
import { TagRow } from "../components/tags/tag-row";
import { postGradient, postMeta, postRatio } from "../lib/post-fixtures";
import { lookupTag, postTags } from "../lib/tags";
import { MAX_COLUMNS, MIN_COLUMNS, useGalleryStore } from "../stores/gallery";

/** Tags shown in the sidebar (info pulled from the catalog). */
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

/** Related tags = co-occurring tags of the current set, minus the set itself. */
const RELATED_TAGS = [
  ...new Set(SIDEBAR_TAGS.flatMap((name) => lookupTag(name).related)),
]
  .filter((name) => !SIDEBAR_TAGS.includes(name))
  .slice(0, 12);

const PER_PAGE = 42;
const TOTAL_PAGES = 250;
const COLUMN_CHOICES = Array.from(
  { length: MAX_COLUMNS - MIN_COLUMNS + 1 },
  (_, i) => MIN_COLUMNS + i,
);

/** A window of page numbers centred on the current page. */
function pageWindow(current: number, total: number, span = 5): number[] {
  const end = Math.min(total, Math.max(current + 2, span));
  const start = Math.max(1, end - span + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export function PostsPage() {
  const columns = useGalleryStore((s) => s.columns);
  const setColumns = useGalleryStore((s) => s.setColumns);
  const showScores = useGalleryStore((s) => s.showScores);
  const setShowScores = useGalleryStore((s) => s.setShowScores);
  const boardMode = useGalleryStore((s) => s.boardMode);
  const setBoardMode = useGalleryStore((s) => s.setBoardMode);

  const [page, setPage] = useState(1);
  const firstId = (page - 1) * PER_PAGE + 1;
  const classic = boardMode === "classic";

  // Classic = uniform square grid; fluid = masonry (mixed aspect ratios).
  const gridStyle: CSSProperties = classic
    ? { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: "0.5rem" }
    : { columnCount: columns, columnGap: "0.5rem" };

  return (
    <div className="flex gap-4">
      {/* Sidebar: search · tags (grouped) · related tags */}
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

      {/* Main: subnav + controls + grid + pagination */}
      <section className="min-w-0 flex-1">
        <nav className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-2 text-[12px]">
          <span className="font-bold">Posts</span>
          <a href="#" className="hover:underline">Popular</a>
          <a href="#" className="hover:underline">Curated</a>
          <a href="#" className="hover:underline">Hot</a>

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
              <label className="flex cursor-pointer items-center gap-2 select-none">
                <input
                  type="checkbox"
                  checked={showScores}
                  onChange={(e) => setShowScores(e.target.checked)}
                />
                Show scores
              </label>
              <div className="mt-2">
                <div className="mb-1 text-muted">Layout</div>
                <div className="flex gap-1">
                  <ModeButton active={!classic} onClick={() => setBoardMode("fluid")}>
                    Fluid
                  </ModeButton>
                  <ModeButton active={classic} onClick={() => setBoardMode("classic")}>
                    Classic
                  </ModeButton>
                </div>
              </div>
            </DropdownMenu>

            <Link to="/uploads/new" className="hover:underline">
              Upload
            </Link>
          </div>
        </nav>

        <div style={gridStyle}>
          {Array.from({ length: PER_PAGE }, (_, i) => {
            const id = firstId + i;
            const meta = postMeta(id);
            return (
              <HoverPopover
                key={id}
                className={classic ? "block" : "mb-2 block break-inside-avoid"}
                placement="top"
                render={() => <PostTagsCard postId={id} tags={postTags(id)} />}
              >
                <Link
                  to="/posts/$id"
                  params={{ id: String(id) }}
                  className="relative block w-full overflow-hidden rounded border-2 border-line hover:border-link"
                  style={{
                    aspectRatio: classic ? "1 / 1" : postRatio(id),
                    background: postGradient(meta.hue),
                  }}
                >
                  {showScores && (
                    <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
                      <span className="flex items-center gap-0.5">
                        <ChevronUp className="h-3 w-3" />
                        {meta.score}
                      </span>
                      <span className="flex items-center gap-0.5">
                        <Heart className="h-3 w-3" />
                        {meta.favorites}
                      </span>
                    </span>
                  )}
                </Link>
              </HoverPopover>
            );
          })}
        </div>

        {/* Pagination: first · prev · window · next · last */}
        <div className="mt-4 flex items-center justify-center gap-1 text-[12px]">
          <PageButton disabled={page === 1} onClick={() => setPage(1)}>
            « First
          </PageButton>
          <PageButton disabled={page === 1} onClick={() => setPage(page - 1)}>
            ‹ Prev
          </PageButton>
          {pageWindow(page, TOTAL_PAGES).map((p) => (
            <button
              key={p}
              type="button"
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
          <PageButton disabled={page === TOTAL_PAGES} onClick={() => setPage(page + 1)}>
            Next ›
          </PageButton>
          <PageButton disabled={page === TOTAL_PAGES} onClick={() => setPage(TOTAL_PAGES)}>
            Last »
          </PageButton>
        </div>
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
