import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import pkg from "../../package.json";
import { ThemeSwitcher } from "../components/theme-switcher";
import { VisitorCounter } from "../components/visitor-counter";
import { useApplyTheme } from "../stores/theme";

const VERSION = pkg.version;

/**
 * Top-level menu, mirroring Danbooru's primary nav. Only items with a real
 * route navigate; the rest are placeholders until their routes exist.
 */
const MENU = [
  { label: "Posts", to: "/posts" as const },
  { label: "Comments" },
  { label: "Notes" },
  { label: "Artists" },
  { label: "Tags" },
  { label: "Pools" },
  { label: "Wiki" },
  { label: "Forum" },
  { label: "More »" },
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
    // Flex column so the footer can be pushed to the bottom of the viewport even
    // when the page content is short (e.g. the empty gallery).
    <div className="flex min-h-screen flex-col">
      {!isHome && (
        <header className="border-b border-line bg-surface">
          <div className="flex items-center gap-4 px-4 py-1.5">
            <Link to="/" className="text-lg font-bold text-ink hover:no-underline">
              Bun<span className="text-link">booru</span>
            </Link>

            <nav className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {MENU.map((item) =>
                "to" in item ? (
                  <Link key={item.label} to={item.to} className="text-[12px] hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span key={item.label} className="cursor-default text-[12px] text-muted">
                    {item.label}
                  </span>
                ),
              )}
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
              <ThemeSwitcher />
              <AccountLinks />
            </div>
          </div>
        </header>
      )}

      {/* flex-1 makes the content area absorb spare height so the footer hugs
          the bottom instead of floating up under short pages. */}
      <main className={`flex-1 ${isHome ? "mx-auto w-full max-w-6xl px-3 py-4" : "px-4 py-4"}`}>
        <Outlet />
      </main>

      <footer className="mt-auto border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-1 px-3 py-3 text-[12px] text-muted">
          <VisitorCounter />
          <div>Running Bunbooru ver {VERSION}</div>
        </div>
      </footer>
    </div>
  );
}
