import { Link } from "@tanstack/react-router";

import { TAG_TEXT_CLASS, type TagDto } from "../../lib/tags";
import { HoverPopover } from "../popover/hover-popover";
import { TagPopoverCard } from "../popover/tag-popover-card";

/**
 * A single clickable tag: navigates to the gallery filtered by this tag
 * (`/posts?q=<name>`), coloured by its category. By default it also shows a
 * related-tags popover on hover (the popover's query fires only once it opens);
 * pass `popover={false}` where nesting a popover would be awkward — e.g. inside
 * the gallery tile's own hover card.
 */
export function TagLink({ tag, popover = true }: { tag: TagDto; popover?: boolean }) {
  const link = (
    <Link
      to="/posts"
      search={{ q: tag.name }}
      className={`${TAG_TEXT_CLASS[tag.category]} hover:underline`}
    >
      {tag.name}
    </Link>
  );
  if (!popover) return link;
  return (
    <HoverPopover placement="top-start" render={() => <TagPopoverCard tag={tag} />}>
      {link}
    </HoverPopover>
  );
}
