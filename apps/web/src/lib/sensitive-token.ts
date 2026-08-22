import { useEffect, useState } from "react";

/**
 * Read a one-time `?token=` from the current URL and immediately harden the page
 * against leaking it:
 *
 * - Installs `<meta name="referrer" content="no-referrer">` while the page is
 *   mounted, so the token can't ride out on a `Referer` header to any resource
 *   the page might touch.
 * - Strips the token from the address bar via `history.replaceState`, so it never
 *   lingers in browser history, bookmarks, or a pasted bug report.
 *
 * The token is captured into state on first render, so removing it from the URL
 * doesn't lose it. Returns the raw token (or null when absent).
 */
export function useSensitiveToken(): string | null {
  const [token] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("token");
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Referrer hardening for as long as this page is shown.
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);

    // Drop the token from the visible URL without a navigation.
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }

    return () => {
      meta.remove();
    };
  }, []);

  return token;
}
