import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { INPUT_CLASS } from "../../components/card-styles";
import { unwrap } from "../../lib/api";
import { authErrorMessage, useCurrentUser } from "../../lib/auth";
import type { SlotPropsMap } from "../slots";
import { displayName, pools } from "./client";

/**
 * The post page's pools widget (`post-detail-aside` slot): each pool this post
 * is in, with its place there and previous/next links, plus "Add to pool" for a
 * signed-in member's own pools. Renders nothing for an anonymous viewer when
 * the post is in no pool.
 */
export function PoolNav({ asset }: SlotPropsMap["post-detail-aside"]) {
  const { data: user } = useCurrentUser();
  const memberships = useQuery({
    queryKey: ["pools", "asset", asset.id],
    queryFn: async () => unwrap(await pools.assets({ id: String(asset.id) }).get()),
  });

  if (!user && (memberships.data?.length ?? 0) === 0) return null;

  return (
    <div>
      <h3 className="mb-1 font-bold">Pools</h3>
      {memberships.data && memberships.data.length > 0 ? (
        <ul className="mb-2 space-y-1 text-[12px]">
          {memberships.data.map((pool) => (
            <li key={pool.id}>
              <Link to="/pools/$poolId" params={{ poolId: String(pool.id) }} className="text-link hover:underline">
                {displayName(pool.name)}
              </Link>{" "}
              <span className="text-muted">
                ({pool.position}/{pool.size})
              </span>
              <div className="flex gap-3">
                {pool.prevId ? (
                  <Link to="/posts/$id" params={{ id: String(pool.prevId) }} className="text-link hover:underline">
                    ‹ prev
                  </Link>
                ) : (
                  <span className="text-muted">‹ prev</span>
                )}
                {pool.nextId ? (
                  <Link to="/posts/$id" params={{ id: String(pool.nextId) }} className="text-link hover:underline">
                    next ›
                  </Link>
                ) : (
                  <span className="text-muted">next ›</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {user ? (
        <AddToPool
          userId={user.id}
          assetId={asset.id}
          inPools={new Set((memberships.data ?? []).map((p) => p.id))}
        />
      ) : null}
    </div>
  );
}

/** Pick one of your pools and add this post to its end. */
function AddToPool({
  userId,
  assetId,
  inPools,
}: {
  userId: number;
  assetId: number;
  inPools: ReadonlySet<number>;
}) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState("");
  const mine = useQuery({
    // Keyed by viewer: the cache outlives a sign-out, and another account
    // signing in must not be offered the previous one's pools.
    queryKey: ["pools", "mine", userId],
    queryFn: async () => unwrap(await pools.mine.get()),
  });
  const add = useMutation({
    mutationFn: async (poolId: number) =>
      unwrap(await pools.pools({ id: String(poolId) }).posts.post({ assetId })),
    onSuccess: () => {
      setChoice("");
      void queryClient.invalidateQueries({ queryKey: ["pools"] });
    },
  });

  const options = (mine.data ?? []).filter((pool) => !inPools.has(pool.id));
  if (mine.isSuccess && (mine.data ?? []).length === 0) {
    return (
      <p className="text-[12px] text-muted">
        <Link to="/pools" className="text-link hover:underline">
          Create a pool
        </Link>{" "}
        to collect posts.
      </p>
    );
  }
  if (options.length === 0) return null;

  return (
    <div className="space-y-1 text-[12px]">
      <div className="flex gap-1">
        <select
          aria-label="Add this post to one of your pools"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">Add to pool…</option>
          {options.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {displayName(pool.name)} ({pool.postCount})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!choice || add.isPending}
          onClick={() => add.mutate(Number(choice))}
          className="flex items-center gap-1 rounded border border-line px-2 hover:border-link disabled:cursor-not-allowed disabled:opacity-50"
        >
          {add.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Add
        </button>
      </div>
      {add.isError ? (
        <p role="alert" className="text-tag-artist">
          {authErrorMessage(add.error, "Couldn’t add it to that pool.")}
        </p>
      ) : null}
    </div>
  );
}
