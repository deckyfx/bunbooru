import { serve } from "bun";

import index from "./index.html";

/** Web dev/serve port (default 3001 so it can run alongside the API on 3000). */
const port = Number(Bun.env.WEB_PORT ?? "3001") || 3001;
/** Bind all interfaces by default so the dev server is reachable on the LAN. */
const hostname = Bun.env.WEB_HOST ?? "0.0.0.0";
/** Enable Bun's dev bundling/HMR unless explicitly in production. */
const development = Bun.env.NODE_ENV !== "production";
/**
 * Where to proxy `/api/*` in dev (the API listens on 3000 by default). Strip any
 * trailing slash so concatenating the request path can't yield `//api/...`,
 * which some upstreams route differently.
 */
const apiTarget = (Bun.env.API_TARGET ?? "http://localhost:3000").replace(/\/+$/, "");
/**
 * Per-proxied-request timeout. Bun's default fetch timeout is ~5 min, long
 * enough that a stalled/silent upstream would hold a dev request open for ages.
 * Cap it so `/api/*` fails fast with a 504 instead — generous enough not to
 * abort legitimate dev uploads (this dev-only proxy isn't on the prod path,
 * where the API serves the SPA directly).
 */
const PROXY_TIMEOUT_MS = 120_000;

/**
 * Serve the single-page app. `/api/*` is reverse-proxied to the API so the
 * browser talks to a single origin (Model A topology) — the Eden client uses
 * `window.location.origin`, so there's no CORS in dev or prod. Every other route
 * returns `index.html`; the client router takes over, and Bun bundles
 * `index.tsx` + assets (Tailwind via bun-plugin-tailwind from bunfig.toml).
 */
const server = serve({
  port,
  hostname,
  development,
  routes: {
    // Re-target at the API, preserving method/headers/body (streams multipart
    // uploads through unchanged). A failed upstream becomes a deterministic 502
    // rather than an opaque server error.
    "/api/*": async (req) => {
      const { pathname, search } = new URL(req.url);
      try {
        return await fetch(new Request(`${apiTarget}${pathname}${search}`, req), {
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        });
      } catch (error) {
        // A timeout means the upstream stalled (504); anything else is a
        // connect/transport failure (502). Both are deterministic, not opaque.
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        return new Response(timedOut ? "Upstream API timed out" : "Upstream API unavailable", {
          status: timedOut ? 504 : 502,
        });
      }
    },
    "/*": index,
  },
});

/** Log the target without any basic-auth credentials it might carry. */
const apiTargetForLog = (() => {
  try {
    const url = new URL(apiTarget);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<invalid API_TARGET>";
  }
})();

console.log(`🐇 Bunbooru web on ${server.url} (api → ${apiTargetForLog})`);
