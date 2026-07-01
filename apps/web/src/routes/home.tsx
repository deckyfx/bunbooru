import { useState } from "react";

import { Link, useNavigate } from "@tanstack/react-router";

import { AccountLinks } from "../components/account-links";
import { Counter } from "../components/counter";
import { ThemeSwitcher } from "../components/theme-switcher";
import { useCurrentUser } from "../lib/auth";
import { useSiteStats } from "../lib/stats";

/** Centered landing menu (safebooru-style front page). */
const HOME_MENU = [
  { label: "Posts", to: "/posts" },
  { label: "Upload", to: "/uploads/new" },
  { label: "Tags", to: "/posts" },
  { label: "Pools", to: "/posts" },
  { label: "Wiki", to: "/posts" },
  { label: "Comments", to: "/posts" },
  { label: "Forum", to: "/posts" },
] as const;

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { data: stats } = useSiteStats();
  // `AccountLinks` renders nothing until `/auth/me` resolves; gate the divider on
  // the same state so the strip never shows a lone "·" before it appears.
  const { isPending: authPending } = useCurrentUser();
  // Render the live post total once loaded; the odometer needs a numeric string.
  const postCount = stats ? String(stats.posts) : null;

  return (
    <div className="flex min-h-[82vh] flex-col justify-center space-y-8">
      {/* Banner image goes here — placeholder until real artwork is supplied. */}
      <div className="flex aspect-1100/240 w-full items-center justify-center rounded-lg border-2 border-dashed border-line bg-bg text-muted">
        Banner image
      </div>

      {/* Welcome + counter — large and centered. */}
      <section className="flex flex-col items-center gap-6 py-4 text-center">
        <h1 className="text-4xl font-bold sm:text-5xl">
          Bun<span className="text-link">booru</span>
        </h1>
        <p className="text-lg text-muted">
          Serving <strong>{postCount ?? "…"}</strong> posts and counting.
        </p>
        {postCount !== null && <Counter value={postCount} digitClass="h-16 sm:h-20" />}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ to: "/posts" });
          }}
          className="flex w-full max-w-xl items-center pt-2"
        >
          <input
            type="search"
            aria-label="Search posts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search posts — e.g. 1girl long_hair"
            className="h-10 flex-1 rounded-l border border-line px-3 text-base outline-none focus:border-link"
          />
          <button
            type="submit"
            className="h-10 rounded-r bg-link px-5 text-base text-white hover:no-underline"
          >
            Search
          </button>
        </form>

        <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-base">
          {HOME_MENU.map((item) => (
            <Link key={item.label} to={item.to} className="text-link hover:underline">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3 pt-1 text-sm text-muted">
          <AccountLinks className="text-sm" />
          {authPending ? null : <span aria-hidden>·</span>}
          <ThemeSwitcher />
        </div>
      </section>
    </div>
  );
}
