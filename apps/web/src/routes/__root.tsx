import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import pkg from "../../package.json";
import { ThemeSwitcher } from "../components/theme-switcher";
import { VisitorCounter } from "../components/visitor-counter";
import { useApplyTheme } from "../stores/theme";

const VERSION = pkg.version;

/** Top-level menu items, mirroring Danbooru's primary nav. */
const MENU = [
  { label: "Posts", to: "/posts" },
  { label: "Comments", to: "/posts" },
  { label: "Notes", to: "/posts" },
  { label: "Artists", to: "/posts" },
  { label: "Tags", to: "/posts" },
  { label: "Pools", to: "/posts" },
  { label: "Wiki", to: "/posts" },
  { label: "Forum", to: "/posts" },
  { label: "More »", to: "/posts" },
] as const;

/** Account links, reused by the header and the home corner strip. */
function AccountLinks({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 text-[12px] ${className ?? ""}`}>
      <a href="#">Login</a>
      <a href="#">Sign up</a>
    </div>
  );
}

/**
 * App shell. Off the home page: a Danbooru-style header (wordmark + menu +
 * search + account links). On the home page: no top bar at all — a clean
 * landing whose own centered content carries search, menu, and account links.
 */
export function RootLayout() {
  useApplyTheme();
  const isHome = useRouterState({ select: (s) => s.location.pathname === "/" });

  return (
    <div className="min-h-screen">
      {!isHome && (
        <header className="border-b border-line bg-surface">
          <div className="flex items-center gap-4 px-4 py-1.5">
            <Link to="/" className="text-lg font-bold text-ink hover:no-underline">
              Bun<span className="text-link">booru</span>
            </Link>

            <nav className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {MENU.map((item, i) => (
                <Link key={i} to={item.to} className="text-[12px] hover:underline">
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-3">
              <form
                onSubmit={(e) => e.preventDefault()}
                className="hidden items-center sm:flex"
              >
                <input
                  type="search"
                  placeholder="Search posts"
                  className="h-6 w-44 rounded-l border border-line px-2 text-[12px] outline-none focus:border-link"
                />
                <button
                  type="submit"
                  className="h-6 rounded-r border border-l-0 border-line bg-line/40 px-2 text-[12px]"
                >
                  Go
                </button>
              </form>
              <AccountLinks />
            </div>
          </div>
        </header>
      )}

      <main className={isHome ? "mx-auto max-w-6xl px-3 py-4" : "px-4 py-4"}>
        <Outlet />
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-3 py-6 text-[12px] text-muted">
        <ThemeSwitcher />
        <VisitorCounter />
        <div>Running Bunbooru ver {VERSION}</div>
      </footer>
    </div>
  );
}
