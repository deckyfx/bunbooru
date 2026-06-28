import { TAG_CATEGORY_LABEL, TAG_TEXT_CLASS, formatCount, lookupTag } from "../../lib/tags";

/**
 * Tag popover content: category + count header and a list of related tags.
 * Shown when hovering a tag link (e.g. the posts sidebar). Phase 0 reads the
 * static catalog; Phase 1 swaps in `useTagInfo(name)`.
 */
export function TagPopoverCard({ name }: { name: string }) {
  const tag = lookupTag(name);

  return (
    <div className="w-64 rounded-md border border-line bg-surface p-3 text-[13px] shadow-lg">
      <div className="flex items-baseline justify-between gap-2 border-b border-line pb-2">
        <span className={`font-bold ${TAG_TEXT_CLASS[tag.category]}`}>{tag.name}</span>
        <span className="text-[11px] text-muted">{TAG_CATEGORY_LABEL[tag.category]}</span>
      </div>

      <div className="py-2 text-muted">{formatCount(tag.postCount)} posts</div>

      {tag.related.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-bold text-muted">Related</div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {tag.related.map((rel) => {
              const r = lookupTag(rel);
              return (
                <li key={rel}>
                  <span className={TAG_TEXT_CLASS[r.category]}>{r.name}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
