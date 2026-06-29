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
export const api = treaty<App>(
  typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
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
