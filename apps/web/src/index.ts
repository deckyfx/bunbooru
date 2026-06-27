/**
 * `@bunbooru/web` — the React client (React + TanStack Router + TanStack Query).
 *
 * Consumes the public API over HTTP only; never touches the database or any
 * backend package directly. The React app, routing, and Eden Treaty API client
 * land in a later PR — this entrypoint is intentionally inert.
 */
export const WEB_APP = "@bunbooru/web" as const;
