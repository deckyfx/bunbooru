import { TAG_TEXT_CLASS, formatCount, lookupTag } from "../../lib/tags";
import { HoverPopover } from "../popover/hover-popover";
import { TagPopoverCard } from "../popover/tag-popover-card";

/**
 * One sidebar tag row: a wiki link, the category-coloured tag (with its
 * related-tags popover on hover), and the post count. Shared by the gallery
 * sidebar and the post-detail sidebar.
 */
export function TagRow({ name }: { name: string }) {
  const tag = lookupTag(name);
  return (
    <li className="flex items-baseline gap-1 leading-tight">
      <a href="#" className="text-muted hover:no-underline" title="wiki">
        ?
      </a>
      <HoverPopover placement="right-start" render={() => <TagPopoverCard name={name} />}>
        <a href="#" className={`${TAG_TEXT_CLASS[tag.category]} hover:underline`}>
          {tag.name}
        </a>
      </HoverPopover>
      <span className="ml-auto text-[11px] text-muted">{formatCount(tag.postCount)}</span>
    </li>
  );
}
