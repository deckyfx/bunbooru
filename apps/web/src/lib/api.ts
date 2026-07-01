import { treaty } from "@elysiajs/eden";

import type { App } from "@bunbooru/api";

/**
 * Type-safe API client (Eden Treaty) — the ONLY way the frontend talks to the
 * API. Never call `fetch` directly: Eden derives request/response types from the
 * server's {@link App} type, so a route rename or payload change is a compile
 * error here, not a runtime 404.
 *
 * Base = `window.location.origin` (same-origin): in prod the API serves this SPA
 * on one origin; in dev the web server proxies `/api/*` to the API. Either way
 * there's no CORS. The SSR fallback origin is never actually used in this SPA.
 */
/** localStorage key for the client-owned anonymous visitor id. */
const VISITOR_KEY = "bunbooru:visitor";

/**
 * A stable, client-owned anonymous visitor id (a random uuid in localStorage).
 * Sent on every request as `x-visitor-id` so the server attributes views/visits
 * to one browser without minting a cookie per request — which would race across
 * a first-load request burst and count one human several times. Opaque, not an
 * IP; clearing site data resets it, exactly like a cookie.
 */
let volatileVisitorId: string | null = null;

/**
 * A random opaque id (32 hex chars) built from `crypto.getRandomValues`. We do
 * NOT use `crypto.randomUUID()`: it's only defined in **secure contexts** (HTTPS
 * or localhost), so over plain HTTP on a LAN IP it's `undefined` and throws —
 * which would make the `x-visitor-id` header callback throw and break EVERY API
 * request. `getRandomValues` is available in insecure contexts too.
 */
function randomVisitorId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function visitorId(): string {
  // localStorage can throw (private mode, disabled, quota). A header callback
  // that rejects would fail EVERY request, so fall back to an in-memory id —
  // the server treats a missing/changed id as a new visitor, no worse than that.
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (id === null || !/^[0-9a-f-]{8,64}$/i.test(id)) {
      id = randomVisitorId();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    volatileVisitorId ??= randomVisitorId();
    return volatileVisitorId;
  }
}

export const api = treaty<App>(
  typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
  typeof window !== "undefined"
    ? {
        headers: () => ({ "x-visitor-id": visitorId() }),
        // Auth rides the httpOnly session cookie (JS can't read it), not a header
        // like `x-visitor-id`. `credentials: "include"` guarantees the cookie is
        // sent even if the API is ever served from a different origin behind a
        // proxy; for the same-origin default it's a harmless no-op.
        fetch: { credentials: "include" },
      }
    : undefined,
);

/** Public URL for an asset's stored bytes (used as an `<img src>`, not a data call). */
export function assetFileUrl(id: number): string {
  return `/api/v1/assets/${id}/file`;
}

/**
 * Unwrap an Eden Treaty response: throw on transport/HTTP error, then narrow out
 * the API's `{ error }` envelope. The global `onError` handler's return type is
 * merged by Elysia into every route's response type, so `data` is typed as
 * `Success | envelope` even though non-2xx bodies actually arrive on `error`.
 */
export function unwrap<T>(res: { data: T | null; error: unknown }): Exclude<T, { error: unknown }> {
  if (res.error) throw res.error;
  if (res.data == null) throw new Error("Unexpected API response");
  // Eden routes non-2xx bodies to `res.error`, so a non-null `data` is a success
  // payload; the envelope is removed at the type level only (never at runtime, so
  // a payload that legitimately carries an `error` field isn't misread as failed).
  return res.data as Exclude<T, { error: unknown }>;
}
