import { Link } from "@tanstack/react-router";

import {
  TAG_CATEGORY_LABEL,
  TAG_TEXT_CLASS,
  formatCount,
  useRelatedTags,
  type TagDto,
} from "../../lib/tags";

/**
 * Tag popover content: the tag's own category + post count, and its most
 * co-occurring ("Related") tags from `GET /tags/:name/related` (fetched lazily —
 * this only mounts while the popover is open). Related tags are plain links (no
 * nested popover) to keep hovering simple.
 */
export function TagPopoverCard({ tag }: { tag: TagDto }) {
  const { data: related, isLoading } = useRelatedTags(tag.name);

  return (
    <div className="w-64 rounded-md border border-line bg-surface p-3 text-[13px] shadow-lg">
      <div className="flex items-baseline justify-between gap-2 border-b border-line pb-2">
        <span className={`font-bold ${TAG_TEXT_CLASS[tag.category]}`}>{tag.name}</span>
        <span className="text-[11px] text-muted">{TAG_CATEGORY_LABEL[tag.category]}</span>
      </div>

      <div className="py-2 text-muted">{formatCount(tag.postCount)} posts</div>

      <div>
        <div className="mb-1 text-[11px] font-bold text-muted">Related</div>
        {isLoading ? (
          <p className="text-[11px] text-muted">Loading…</p>
        ) : !related || related.length === 0 ? (
          <p className="text-[11px] text-muted">None yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {related.map((r) => (
              <li key={r.name}>
                <Link
                  to="/posts"
                  search={{ q: r.name }}
                  className={`${TAG_TEXT_CLASS[r.category]} hover:underline`}
                >
                  {r.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
