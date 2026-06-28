import { CATEGORY_ORDER, TAG_CATEGORY_LABEL, groupByCategory } from "../../lib/tags";
import { TagRow } from "./tag-row";

/**
 * Tag names grouped into category sub-sections (Copyright, Character, Artist,
 * General, Meta) — the Danbooru-style sidebar grouping. Shared by the gallery
 * and post-detail sidebars.
 */
export function TagGroups({ names }: { names: string[] }) {
  const grouped = groupByCategory(names);
  return (
    <div className="space-y-2">
      {CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => (
        <div key={category}>
          <div className="text-[11px] font-bold text-muted">
            {TAG_CATEGORY_LABEL[category]}
          </div>
          <ul className="space-y-0.5">
            {grouped.get(category)?.map((name) => (
              <TagRow key={name} name={name} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
