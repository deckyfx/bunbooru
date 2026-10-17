import { useMemo } from "react";

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";

import { excerpt, tokenize } from "@bunbooru/plugin-wiki/markup";
import { displayTitle, plainSearchTag } from "@bunbooru/plugin-wiki/title";

import { useCurrentUser } from "../../lib/auth";
import type { SlotPropsMap } from "../slots";
import { fetchPage, pageKey } from "./client";
import { WikiBody } from "./WikiBody";

/** Visible characters of the page shown above the results. */
const EXCERPT_LENGTH = 300;

/**
 * Above the gallery (`posts-search`): when the search is exactly one plain
 * tag, the start of that tag's wiki page and a "Read more" link. With no page,
 * a signed-in viewer gets a link to write one; anyone else sees nothing, as
 * they do for an empty or complex query, while loading, or on an error.
 */
export function WikiExcerpt({ query }: SlotPropsMap["posts-search"]) {
  const { data: user } = useCurrentUser();
  const tag = plainSearchTag(query);

  const page = useQuery({
    queryKey: pageKey(tag ?? ""),
    enabled: tag !== null,
    queryFn: () => fetchPage(tag ?? ""),
  });

  const preview = useMemo(
    () => (page.data ? excerpt(tokenize(page.data.body), EXCERPT_LENGTH) : null),
    [page.data],
  );

  if (tag === null || page.isPending || page.isError) return null;

  if (!preview) {
    if (!user) return null;
    return (
      <p className="text-[12px] text-muted">
        <Link to="/wiki/$title" params={{ title: tag }} className="text-link hover:underline">
          Create a wiki page for this tag
        </Link>
      </p>
    );
  }

  return (
    <aside aria-label={`Wiki: ${displayTitle(tag)}`} className="rounded border border-line bg-surface p-3">
      <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-bold">
        <BookOpen className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        {displayTitle(tag)}
      </h2>
      <WikiBody tokens={preview.tokens} />
      <Link to="/wiki/$title" params={{ title: tag }} className="mt-1 inline-block text-[12px] text-link hover:underline">
        Read more ›
      </Link>
    </aside>
  );
}
