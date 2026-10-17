import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";

import type { Vote } from "@bunbooru/plugin-scores";

import { unwrap } from "../../lib/api";
import { authErrorMessage, useCurrentUser } from "../../lib/auth";
import type { SlotPropsMap } from "../slots";
import { scoresApi } from "./client";

const statusKey = (assetId: number) => ["scores", "status", assetId] as const;

/**
 * The post page's score (`post-detail-aside` slot): ▲ score ▼, with the
 * viewer's own vote highlighted. Clicking the active arrow takes the vote back.
 * Anonymous viewers see the score and a sign-in link instead of buttons that
 * would only 401.
 */
export function ScoreWidget({ asset }: SlotPropsMap["post-detail-aside"]) {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const endpoint = scoresApi.api.v1.plugins.scores.assets({ id: String(asset.id) });
  // Keyed by viewer too, so signing in or out refetches `mine`.
  const queryKey = [...statusKey(asset.id), user?.id ?? null];

  const status = useQuery({ queryKey, queryFn: async () => unwrap(await endpoint.get()) });
  const cast = useMutation({
    mutationFn: async (value: Vote) => unwrap(await endpoint.put({ value })),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next);
      // `score:` results may have changed.
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const mine = status.data?.mine ?? 0;
  const busy = status.isLoading || cast.isPending;
  /** Vote `value`, or take the vote back when it's already the viewer's. */
  const press = (value: 1 | -1) => cast.mutate(mine === value ? 0 : value);

  const arrow = (value: 1 | -1) => {
    const active = mine === value;
    const Icon = value === 1 ? ChevronUp : ChevronDown;
    const label = value === 1 ? "Vote up" : "Vote down";
    return (
      <button
        type="button"
        aria-label={active ? `Remove ${label.toLowerCase()}` : label}
        aria-pressed={active}
        disabled={busy}
        onClick={() => press(value)}
        className={`rounded border p-0.5 disabled:cursor-not-allowed disabled:opacity-60 ${
          active ? "border-link text-link" : "border-line hover:border-link"
        }`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  };

  const score = status.data?.score ?? 0;

  return (
    <div>
      <h3 className="mb-1 font-bold">Score</h3>
      <div className="flex items-center gap-2 text-[12px]">
        {user ? arrow(1) : null}
        <span
          className="min-w-[2ch] text-center font-bold"
          title={status.data ? `${status.data.up} up, ${status.data.down} down` : undefined}
        >
          {status.isLoading ? "…" : score}
        </span>
        {user ? (
          arrow(-1)
        ) : (
          <Link to="/login" className="text-link hover:underline">
            Log in to vote
          </Link>
        )}
      </div>
      {cast.isError ? (
        <p role="alert" className="mt-1 text-[12px] text-tag-artist">
          {authErrorMessage(cast.error, "Couldn’t save your vote.")}
        </p>
      ) : null}
    </div>
  );
}
