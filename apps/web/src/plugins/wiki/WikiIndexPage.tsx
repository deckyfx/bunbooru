import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { BookOpen, Loader2 } from "lucide-react";

import { parseTitle } from "@bunbooru/plugin-wiki/title";

import { CARD_CLASS, INPUT_CLASS } from "../../components/card-styles";
import { unwrap } from "../../lib/api";
import { useCurrentUser } from "../../lib/auth";
import { WIKI_KEY, wikiApi } from "./client";

/** `/wiki`: every page alphabetically, a title-prefix search, and (for members) a way to start a page. */
export function WikiIndexPage() {
  const { data: user } = useCurrentUser();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");

  const list = useInfiniteQuery({
    queryKey: [...WIKI_KEY, "index", search],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await wikiApi.pages.get({
          query: { ...(search ? { q: search } : {}), ...(pageParam ? { after: pageParam } : {}) },
        }),
      ),
    getNextPageParam: (page) => page.nextAfter ?? undefined,
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setSearch(query.trim());
  }

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-2">
        <h1 className="text-base font-bold">Wiki</h1>
        <form onSubmit={onSearch} className="ml-auto flex gap-2" role="search">
          <input
            type="search"
            aria-label="Search wiki titles"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title starts with…"
            maxLength={200}
            className={`${INPUT_CLASS} w-48`}
          />
          <button type="submit" className="rounded border border-line px-3 text-[12px] hover:border-link">
            Search
          </button>
        </form>
      </div>

      {user ? <StartPage /> : null}

      {list.isPending ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : list.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load the wiki.
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-[12px] text-muted">
          <BookOpen className="h-12 w-12 text-line" strokeWidth={1.25} aria-hidden="true" />
          {search ? `No pages start with “${search}”.` : "No wiki pages yet."}
        </div>
      ) : (
        <ul className="max-w-3xl divide-y divide-line text-[12px]">
          {items.map((page) => (
            <li key={page.title} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
              <Link to="/wiki/$title" params={{ title: page.title }} className="font-medium text-link hover:underline">
                {page.title}
              </Link>
              <span className="text-muted">
                v{page.version}
                {page.updatedByName ? ` · ${page.updatedByName}` : ""} ·{" "}
                <time dateTime={page.updatedAt}>{new Date(page.updatedAt).toLocaleDateString()}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <button
          type="button"
          onClick={() => {
            if (!list.isFetchingNextPage) void list.fetchNextPage();
          }}
          disabled={list.isFetchingNextPage}
          className="rounded border border-line px-3 py-1 text-[12px] hover:bg-bg disabled:opacity-60"
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

/** Open a page by title (to create it, or edit an existing one). */
function StartPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const parsed = parseTitle(title);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (parsed.ok) void navigate({ to: "/wiki/$title", params: { title: parsed.title } });
  }

  return (
    <form onSubmit={onSubmit} className={`${CARD_CLASS} flex max-w-xl flex-wrap items-end gap-2 p-3`}>
      <label className="block min-w-0 flex-1">
        <span className="mb-1 block text-[11px] font-bold text-muted">Write a page (usually a tag’s name)</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. blue_sky"
          maxLength={200}
          className={INPUT_CLASS}
        />
      </label>
      <button
        type="submit"
        disabled={!parsed.ok}
        className="rounded bg-link px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        Open
      </button>
      {title.trim() && !parsed.ok ? (
        <p role="alert" className="w-full text-[12px] text-tag-artist">
          {parsed.reason}
        </p>
      ) : null}
    </form>
  );
}
