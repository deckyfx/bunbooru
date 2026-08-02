import {
  CATEGORY_ORDER,
  TAG_CATEGORY_LABEL,
  formatCount,
  groupTagsByCategory,
  type TagDto,
} from "../../lib/tags";
import { TagLink } from "./tag-link";

/**
 * A read-only, category-grouped tag list for the sidebar — e.g. the tags
 * appearing on the current gallery page. Each tag links to its search and shows
 * its global post count. (Editing lives in `PostTagPanel`; this is display-only.)
 */
export function TagListPanel({
  title,
  tags,
  isLoading,
  isError,
  emptyLabel = "No tags.",
}: {
  title: string;
  tags: TagDto[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  emptyLabel?: string;
}) {
  const grouped = groupTagsByCategory(tags ?? []);

  return (
    <section>
      <h3 className="mb-1 font-bold">{title}</h3>
      {isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : isError ? (
        <p className="text-[12px] text-tag-artist">Couldn’t load tags.</p>
      ) : !tags || tags.length === 0 ? (
        <p className="text-[12px] text-muted">{emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => (
            <div key={category}>
              <div className="text-[11px] font-bold text-muted">{TAG_CATEGORY_LABEL[category]}</div>
              <ul className="space-y-0.5">
                {grouped.get(category)?.map((tag) => (
                  <li key={tag.name} className="flex items-baseline gap-1 leading-tight">
                    <TagLink tag={tag} />
                    <span className="ml-auto text-[11px] text-muted">{formatCount(tag.postCount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
