import type { CredentialKind } from "@bunbooru/core";

/**
 * The routes an upload-scoped API key may call (`METHOD route-pattern`): add
 * posts (one-shot and resumable), check who it belongs to, and look up tags
 * for autocomplete. Everything else is refused, so a leaked ingest-client key
 * can add content but not edit, delete, or reach account and admin routes.
 */
const UPLOAD_SCOPE_ROUTES = new Set([
  "POST /api/v1/assets",
  "POST /api/v1/uploads",
  "HEAD /api/v1/uploads/:token",
  "PATCH /api/v1/uploads/:token",
  "DELETE /api/v1/uploads/:token",
  "GET /api/v1/auth/me",
  "GET /api/v1/tags",
]);

/**
 * Whether a request authenticated by `kind` may call `route` (Elysia's
 * matched pattern, e.g. `/api/v1/uploads/:token`). Sessions and full keys may
 * call anything their user can; an upload key only {@link UPLOAD_SCOPE_ROUTES}.
 */
export function credentialAllows(kind: CredentialKind | null, method: string, route: string): boolean {
  if (kind !== "upload") return true;
  return UPLOAD_SCOPE_ROUTES.has(`${method.toUpperCase()} ${route}`);
}
