import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { useCurrentUser } from "../../lib/auth";
import type { SlotPropsMap } from "../slots";
import { CommentForm } from "./CommentForm";
import { CommentItem } from "./CommentItem";
import { COMMENTS_KEY, commentsApi } from "./client";

/**
 * The post page's comments (`post-detail-main`, under the image): the thread
 * oldest first with "load more", and a box to post one for a signed-in viewer
 * (a log-in link otherwise).
 */
export function CommentThread({ asset }: SlotPropsMap["post-detail-main"]) {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const endpoint = commentsApi.assets({ id: String(asset.id) });

  const thread = useInfiniteQuery({
    // Keyed by viewer too: each item's `canEdit` depends on who's asking.
    queryKey: [...COMMENTS_KEY, "asset", asset.id, user?.id ?? null],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(await endpoint.get({ query: pageParam === undefined ? {} : { after: pageParam } })),
    getNextPageParam: (page) => page.nextAfter ?? undefined,
  });

  const post = useMutation({
    mutationFn: async (body: string) => unwrap(await endpoint.post({ body })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY }),
  });

  const items = thread.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby={`comments-heading-${asset.id}`} className="text-[12px]">
      <h3 id={`comments-heading-${asset.id}`} className="mb-1 font-bold">
        Comments
      </h3>

      {thread.isPending ? (
        <p className="flex items-center gap-1.5 text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : thread.isError ? (
        <p role="alert" className="text-tag-artist">
          Couldn’t load the comments.
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted">No comments yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((comment) => (
            <CommentItem key={comment.id} comment={comment} />
          ))}
        </ul>
      )}
      {thread.hasNextPage ? (
        <button
          type="button"
          onClick={() => {
            if (!thread.isFetchingNextPage) void thread.fetchNextPage();
          }}
          disabled={thread.isFetchingNextPage}
          className="mt-2 rounded border border-line px-3 py-1 hover:bg-bg disabled:opacity-60"
        >
          {thread.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}

      <div className="mt-3">
        {user ? (
          <CommentForm
            label="Write a comment"
            submitLabel="Post comment"
            pending={post.isPending}
            error={post.error}
            onSubmit={(body) => post.mutateAsync(body)}
            clearOnSuccess
          />
        ) : (
          <p className="text-muted">
            <Link to="/login" className="text-link hover:underline">
              Log in
            </Link>{" "}
            to comment.
          </p>
        )}
      </div>
    </section>
  );
}
