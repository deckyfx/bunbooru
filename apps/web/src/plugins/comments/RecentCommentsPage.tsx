import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, MessageSquare } from "lucide-react";

import { unwrap } from "../../lib/api";
import { useCurrentUser } from "../../lib/auth";
import { CommentItem } from "./CommentItem";
import { COMMENTS_KEY, commentsApi } from "./client";

/** `/comments`: the newest comments across every post, each linking to its post. */
export function RecentCommentsPage() {
  const { data: user } = useCurrentUser();

  const recent = useInfiniteQuery({
    // Keyed by viewer too: each item's `canEdit` depends on who's asking.
    queryKey: [...COMMENTS_KEY, "recent", user?.id ?? null],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(await commentsApi.recent.get({ query: pageParam === undefined ? {} : { before: pageParam } })),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

  const items = recent.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="border-b border-line pb-2">
        <h1 className="text-base font-bold">Comments</h1>
      </div>

      {recent.isPending ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : recent.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load comments.
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-[12px] text-muted">
          <MessageSquare className="h-12 w-12 text-line" strokeWidth={1.25} aria-hidden="true" />
          No comments yet.
        </div>
      ) : (
        <ul className="max-w-3xl divide-y divide-line">
          {items.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              context={
                <Link
                  to="/posts/$id"
                  params={{ id: String(comment.assetId) }}
                  className="font-medium text-link hover:underline"
                >
                  Post #{comment.assetId}
                </Link>
              }
            />
          ))}
        </ul>
      )}
      {recent.hasNextPage ? (
        <button
          type="button"
          onClick={() => {
            if (!recent.isFetchingNextPage) void recent.fetchNextPage();
          }}
          disabled={recent.isFetchingNextPage}
          className="rounded border border-line px-3 py-1 text-[12px] hover:bg-bg disabled:opacity-60"
        >
          {recent.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
