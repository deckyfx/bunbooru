import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Star } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage, useCurrentUser } from "../../lib/auth";
import type { SlotPropsMap } from "../slots";
import { favoritesApi } from "./client";

const statusKey = (assetId: number) => ["favorites", "status", assetId] as const;

/**
 * The post page's favorite control (`post-detail-aside` slot): how many people
 * favorited the post, and a ★ toggle for a signed-in viewer. Anonymous viewers
 * see the count and a sign-in link instead of a button that would only 401.
 */
export function FavoriteButton({ asset }: SlotPropsMap["post-detail-aside"]) {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const endpoint = favoritesApi.api.v1.plugins.favorites.assets({ id: String(asset.id) });

  const status = useQuery({
    // Keyed by viewer too, so signing in or out refetches `favorited`.
    queryKey: [...statusKey(asset.id), user?.id ?? null],
    queryFn: async () => unwrap(await endpoint.get()),
  });
  const toggle = useMutation({
    mutationFn: async (favorite: boolean) => unwrap(favorite ? await endpoint.put() : await endpoint.delete()),
    onSuccess: (next) => {
      queryClient.setQueryData([...statusKey(asset.id), user?.id ?? null], next);
      // The viewer's fav: gallery changed too.
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const favorited = status.data?.favorited ?? false;
  const count = status.data?.count ?? 0;

  return (
    <div>
      <h3 className="mb-1 font-bold">Favorites</h3>
      <div className="flex items-center gap-2 text-[12px]">
        {user ? (
          <button
            type="button"
            aria-pressed={favorited}
            disabled={status.isLoading || toggle.isPending}
            onClick={() => toggle.mutate(!favorited)}
            className={`flex items-center gap-1 rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-60 ${
              favorited ? "border-tag-copyright text-tag-copyright" : "border-line hover:border-link"
            }`}
          >
            {toggle.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Star className="h-3.5 w-3.5" fill={favorited ? "currentColor" : "none"} aria-hidden="true" />
            )}
            {favorited ? "Favorited" : "Favorite"}
          </button>
        ) : (
          <Link to="/login" className="text-link hover:underline">
            Log in to favorite
          </Link>
        )}
        <span className="text-muted">
          {status.isLoading ? "…" : `${count} ${count === 1 ? "person" : "people"}`}
        </span>
      </div>
      {toggle.isError ? (
        <p role="alert" className="mt-1 text-[12px] text-tag-artist">
          {authErrorMessage(toggle.error, "Couldn’t update your favorite.")}
        </p>
      ) : null}
    </div>
  );
}
