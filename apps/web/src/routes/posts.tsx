import { type CSSProperties, type ReactNode } from "react";

import { Link, useSearch } from "@tanstack/react-router";
import { ImageOff } from "lucide-react";

import { DropdownMenu } from "../components/menu/dropdown-menu";
import { HoverPopover } from "../components/popover/hover-popover";
import { PostHoverCard } from "../components/popover/post-hover-card";
import { SearchBox } from "../components/popover/search-box";
import { AssetImage } from "../components/asset-image";
import { TagListPanel } from "../components/tags/tag-list-panel";
import { assetFileUrl, assetThumbUrl } from "../lib/api";
import { usePlugins } from "../lib/plugins";
import { useAssetsPage } from "../lib/assets";
import { usePageTags } from "../lib/tags";
import { MAX_COLUMNS, MIN_COLUMNS, useGalleryStore } from "../stores/gallery";

const COLUMN_CHOICES = Array.from(
  { length: MAX_COLUMNS - MIN_COLUMNS + 1 },
  (_, i) => MIN_COLUMNS + i,
);

/** "1 post", "1,234 posts", or "10,000+ posts" when the server stopped counting. */
function formatTotal(total: number, capped: boolean): string {
  const n = total.toLocaleString();
  return capped ? `${n}+ posts` : `${n} post${total === 1 ? "" : "s"}`;
}

export function PostsPage() {
  const columns = useGalleryStore((s) => s.columns);
  const setColumns = useGalleryStore((s) => s.setColumns);
  const boardMode = useGalleryStore((s) => s.boardMode);
  const setBoardMode = useGalleryStore((s) => s.setBoardMode);

  // Booru search query and keyset position from the URL (`/posts?q=…&cursor=…`).
  // Clicking a tag or searching navigates without a cursor, so a new query
  // always starts on its first page; filtering and paging happen server-side.
  const { q, cursor } = useSearch({ from: "/posts" });
  const { data, isLoading, isError, refetch } = useAssetsPage(q, cursor);
  const classic = boardMode === "classic";
  // Tags appearing across the current page's posts (booru-style sidebar).
  const pageTags = usePageTags(data?.assets.map((asset) => asset.id) ?? []);
  // Use the thumbnailer plugin's thumbnails when it's enabled; otherwise the grid
  // requests full images. Either way `AssetImage` falls back to the full image if
  // a thumbnail 404s (not generated yet), and to a placeholder if that also fails.
  const { data: plugins, isLoading: pluginsLoading } = usePlugins();
  const hasThumbnailer = plugins?.some((p) => p.id === "thumbnailer") ?? false;

  // Classic = uniform square grid; fluid = masonry (mixed aspect ratios).
  const gridStyle: CSSProperties = classic
    ? { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: "0.5rem" }
    : { columnCount: columns, columnGap: "0.5rem" };

  return (
    <div className="flex gap-4">
      <aside className="w-64 shrink-0 space-y-4">
        <SearchBox placeholder="Search" className="w-full" />
        <section>
          <h3 className="mb-1 font-bold">Search</h3>
          {q ? (
            <p className="text-[12px]">
              Filtering: <span className="font-mono">{q}</span>{" "}
              <Link to="/posts" search={{}} className="text-link hover:underline">
                clear
              </Link>
            </p>
          ) : (
            <p className="text-[12px] text-muted">Showing all posts.</p>
          )}
        </section>

        <TagListPanel
          title="Tags"
          tags={pageTags.data}
          isLoading={pageTags.isLoading}
          isError={pageTags.isError}
          emptyLabel="No tags on this page."
        />
      </aside>

      <section className="min-w-0 flex-1">
        <nav className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-2 text-[12px]">
          <span className="font-bold">Posts</span>
          {data ? (
            <span className="text-muted">{formatTotal(data.total, data.totalCapped)}</span>
          ) : null}

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
            <div className="flex justify-center gap-3">
              <button type="button" onClick={() => void refetch()} className="hover:underline">
                Retry
              </button>
              {/* A stale or hand-edited cursor is refused (400); offer a clean start. */}
              {cursor ? (
                <Link to="/posts" search={q ? { q } : {}} className="text-link hover:underline">
                  Start from the first page
                </Link>
              ) : null}
            </div>
          </div>
        ) : !data || data.assets.length === 0 ? (
          q ? (
            // A filtered search with no results — distinct from an empty gallery,
            // so it never reads like data loss. Offer to clear the filter.
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <ImageOff className="h-16 w-16 text-line" strokeWidth={1.25} aria-hidden="true" />
              <p className="font-bold">No matches</p>
              <p className="text-[12px] text-muted">
                Nothing tagged <span className="font-mono">{q}</span>.
              </p>
              <Link
                to="/posts"
                search={{}}
                className="rounded border border-line px-3 py-1.5 text-link hover:border-link"
              >
                Clear filter »
              </Link>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <ImageOff className="h-16 w-16 text-line" strokeWidth={1.25} aria-hidden="true" />
              <p className="font-bold">No posts yet</p>
              <p className="text-[12px] text-muted">Your gallery is empty.</p>
              <Link
                to="/uploads/new"
                className="rounded border border-line px-3 py-1.5 text-link hover:border-link"
              >
                Upload the first one »
              </Link>
            </div>
          )
        ) : (
          <div style={gridStyle}>
            {data.assets.map((asset) => (
              <HoverPopover
                key={asset.id}
                interactive={false}
                className={classic ? "block" : "mb-2 block break-inside-avoid"}
                placement="top"
                render={() => <PostHoverCard asset={asset} />}
              >
                <Link
                  to="/posts/$id"
                  params={{ id: String(asset.id) }}
                  className="relative block w-full overflow-hidden rounded border-2 border-line hover:border-link"
                  style={{ aspectRatio: classic ? "1 / 1" : `${asset.width} / ${asset.height}` }}
                >
                  {/* Hold off until the plugin manifest resolves: rendering with
                      the default (thumbnailer off) would fetch full images, and a
                      later src switch can't cancel those in-flight transfers. */}
                  {pluginsLoading ? (
                    <div className="h-full w-full animate-pulse bg-line/40" aria-hidden="true" />
                  ) : (
                    <AssetImage
                      src={hasThumbnailer ? assetThumbUrl(asset.id) : assetFileUrl(asset.id)}
                      fallbackSrc={hasThumbnailer ? assetFileUrl(asset.id) : undefined}
                      alt={`Post ${asset.id}`}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  )}
                </Link>
              </HoverPopover>
            ))}
          </div>
        )}

        {data && (data.prevCursor || data.nextCursor) ? (
          <nav aria-label="Pages" className="mt-4 flex items-center justify-center gap-2 text-[12px]">
            <PageLink cursor={data.prevCursor} q={q}>
              ‹ Newer
            </PageLink>
            <PageLink cursor={data.nextCursor} q={q}>
              Older ›
            </PageLink>
          </nav>
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

/**
 * A pager link to the page `cursor` points at, keeping the query. Rendered inert
 * (not a link) when there's nowhere to go that way. "Newer"/"Older" read right
 * for the default newest-first order; for other `order:`s they mean
 * "previous"/"next" in that order.
 */
function PageLink({
  cursor,
  q,
  children,
}: {
  cursor: string | null;
  q?: string;
  children: ReactNode;
}) {
  const box = "rounded border px-3 py-1";
  if (!cursor) {
    return (
      <span aria-disabled="true" className={`${box} border-line text-muted`}>
        {children}
      </span>
    );
  }
  return (
    <Link
      to="/posts"
      search={{ ...(q ? { q } : {}), cursor }}
      className={`${box} border-line hover:border-link`}
    >
      {children}
    </Link>
  );
}
