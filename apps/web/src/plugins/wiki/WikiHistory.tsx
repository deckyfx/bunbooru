import { useMemo, useState } from "react";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { tokenize } from "@bunbooru/plugin-wiki/markup";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { pageKey, WIKI_KEY, wikiPage } from "./client";
import { WikiBody } from "./WikiBody";

/**
 * The History tab: a page's versions, newest first ("load more" pages back),
 * each viewable; an admin may revert to an old one, which saves it as a new
 * version (history is never rewritten).
 */
export function WikiHistory({
  title,
  currentVersion,
  canRevert,
  onReverted,
}: {
  title: string;
  currentVersion: number;
  canRevert: boolean;
  onReverted: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);

  const history = useInfiniteQuery({
    queryKey: [...WIKI_KEY, "history", title],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(await wikiPage(title).history.get({ query: pageParam === undefined ? {} : { before: pageParam } })),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  if (history.isPending) return <p className="text-[12px] text-muted">Loading…</p>;
  if (history.isError) {
    return (
      <p role="alert" className="text-[12px] text-tag-artist">
        Couldn’t load the history.
      </p>
    );
  }

  return (
    <div className="max-w-3xl space-y-3 text-[12px]">
      <ul className="divide-y divide-line">
        {items.map((version) => (
          <li key={version.version} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
            <button
              type="button"
              onClick={() => setSelected(selected === version.version ? null : version.version)}
              aria-pressed={selected === version.version}
              aria-label={`View version ${version.version}`}
              className="font-medium text-link hover:underline"
            >
              v{version.version}
            </button>
            <span className="text-muted">
              {version.editorName ?? "unknown"} ·{" "}
              <time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</time> ·{" "}
              {version.length.toLocaleString()} chars
              {version.version === currentVersion ? " · current" : ""}
            </span>
          </li>
        ))}
      </ul>
      {history.hasNextPage ? (
        <button
          type="button"
          onClick={() => {
            if (!history.isFetchingNextPage) void history.fetchNextPage();
          }}
          disabled={history.isFetchingNextPage}
          className="rounded border border-line px-3 py-1 hover:bg-bg disabled:opacity-60"
        >
          {history.isFetchingNextPage ? "Loading…" : "Load older"}
        </button>
      ) : null}
      {selected !== null ? (
        <WikiVersion
          key={selected}
          title={title}
          version={selected}
          canRevert={canRevert && selected !== currentVersion}
          onReverted={onReverted}
        />
      ) : null}
    </div>
  );
}

/** One old version's text, and (for an admin) a Revert button. */
function WikiVersion({
  title,
  version,
  canRevert,
  onReverted,
}: {
  title: string;
  version: number;
  canRevert: boolean;
  onReverted: () => void;
}) {
  const queryClient = useQueryClient();
  const old = useQuery({
    queryKey: [...WIKI_KEY, "version", title, version],
    // A past version never changes.
    staleTime: Infinity,
    queryFn: async () => unwrap(await wikiPage(title).versions({ version: String(version) }).get()),
  });
  const tokens = useMemo(() => (old.data ? tokenize(old.data.body) : []), [old.data]);

  const revert = useMutation({
    mutationFn: async () => unwrap(await wikiPage(title).revert.post({ version })),
    onSuccess: (page) => {
      queryClient.setQueryData(pageKey(title), page);
      void queryClient.invalidateQueries({ queryKey: WIKI_KEY });
      onReverted();
    },
  });

  return (
    <section aria-label={`Version ${version}`} className="space-y-2 rounded border border-line p-3">
      <div className="flex items-center gap-2">
        <h3 className="font-bold">Version {version}</h3>
        {canRevert ? (
          <button
            type="button"
            onClick={() => {
              if (!revert.isPending) revert.mutate();
            }}
            disabled={revert.isPending || !old.data}
            className="ml-auto flex items-center gap-1 rounded border border-line px-2 py-0.5 hover:border-link disabled:opacity-60"
          >
            {revert.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Revert to this version
          </button>
        ) : null}
      </div>
      {revert.isError ? (
        <p role="alert" className="text-tag-artist">
          {authErrorMessage(revert.error, "Couldn’t revert the page.")}
        </p>
      ) : null}
      {old.isPending ? (
        <p className="text-muted">Loading…</p>
      ) : old.isError ? (
        <p role="alert" className="text-tag-artist">
          Couldn’t load this version.
        </p>
      ) : (
        <WikiBody tokens={tokens} />
      )}
    </section>
  );
}
