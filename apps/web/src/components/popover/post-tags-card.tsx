import { CATEGORY_ORDER, TAG_TEXT_CLASS, groupByCategory } from "../../lib/tags";

/**
 * Gallery-tile popover content: a post's tags grouped by category. Shown when
 * hovering a thumbnail. Phase 0 takes the tags directly; Phase 1 fetches the
 * post DTO via `usePostPreview(id)`.
 */
export function PostTagsCard({ postId, tags }: { postId: number; tags: string[] }) {
  const grouped = groupByCategory(tags);

  return (
    <div className="w-60 rounded-md border border-line bg-surface p-3 text-[13px] shadow-lg">
      <div className="mb-2 border-b border-line pb-1 font-bold">post #{postId}</div>
      <div className="space-y-1.5">
        {CATEGORY_ORDER.filter((c) => grouped.has(c)).map((category) => (
          <ul key={category} className="flex flex-wrap gap-x-3 gap-y-0.5">
            {grouped.get(category)?.map((name) => (
              <li key={name}>
                <span className={TAG_TEXT_CLASS[category]}>{name}</span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
