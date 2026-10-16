import { useEffect } from "react";

import { Link, useNavigate } from "@tanstack/react-router";

import { useCurrentUser } from "../../lib/auth";

/**
 * `/favorites`: your favorites, which are simply the gallery filtered by
 * `fav:<you>`. Sending the viewer there keeps one gallery (paging, sorting,
 * combining with other terms like `fav:me rating:safe`) instead of a second
 * copy of it.
 */
export function FavoritesPage() {
  const { data: user, isPending } = useCurrentUser();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) void navigate({ to: "/posts", search: { q: `fav:${user.username}` }, replace: true });
  }, [user, navigate]);

  if (isPending || user) return null;
  return (
    <p className="py-16 text-center text-[12px] text-muted">
      <Link to="/login" className="text-link hover:underline">
        Log in
      </Link>{" "}
      to see your favorites.
    </p>
  );
}
