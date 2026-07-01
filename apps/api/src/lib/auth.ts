import { AuthenticationError, type User } from "@bunbooru/core";

/**
 * HTTP glue for session auth. The token is transported two ways so both browsers
 * and API clients work: an httpOnly cookie (set on login, sent automatically by
 * the browser) OR an `Authorization: Bearer <token>` header (for scripts/mobile
 * that capture the token from the login response body). Core stays unaware of all
 * of this — it only ever sees the raw token string.
 */

/**
 * Session cookie name. Uses `_` (not `:`) so it's a valid RFC 6265 cookie-name
 * token; some proxies/clients reject separators like `:`.
 */
export const SESSION_COOKIE = "bunbooru_session";

/** `Bearer ` prefix (case-insensitive scheme) on the Authorization header. */
const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Resolve the session token from a request: `Authorization: Bearer` takes
 * precedence (explicit API use), else the session cookie. Returns null when
 * neither is present.
 *
 * If an Authorization header IS present but isn't a valid Bearer token, we do
 * NOT fall through to the cookie — a caller that supplied explicit credentials
 * shouldn't be silently authenticated by ambient cookie credentials instead.
 */
export function readSessionToken(request: Request): string | null {
  const auth = request.headers.get("authorization")?.trim();
  if (auth) {
    const match = BEARER_RE.exec(auth);
    return match?.[1]?.trim() || null;
  }
  return readCookie(request.headers.get("cookie"), SESSION_COOKIE);
}

/** Extract a single cookie's value from a raw `Cookie` header, or null. */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      // A malformed percent-encoding would make decodeURIComponent throw; since
      // this runs on every request, fall back to the raw value rather than 500.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** Options shared by both cookie builders. */
interface CookieOptions {
  /** Add the `Secure` attribute (production/HTTPS only). */
  secure: boolean;
}

/**
 * Build the `Set-Cookie` value that stores the session token. httpOnly (JS can't
 * read it → XSS can't exfiltrate it), SameSite=Lax (sent on top-level navigation,
 * blocks CSRF on cross-site POSTs), Path=/ (whole API), and Max-Age matching the
 * session lifetime (seconds).
 */
export function buildSessionCookie(
  token: string,
  maxAgeMs: number,
  { secure }: CookieOptions,
): string {
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  return serializeCookie(SESSION_COOKIE, token, maxAgeSec, secure);
}

/** Build the `Set-Cookie` value that clears the session cookie (logout). */
export function buildClearCookie({ secure }: CookieOptions): string {
  return serializeCookie(SESSION_COOKIE, "", 0, secure);
}

/** Assemble a Set-Cookie string with the fixed security attributes. */
function serializeCookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Assert a request is authenticated, returning the {@link User}. Throws
 * {@link AuthenticationError} (→ 401) when there is no valid session — the single
 * gate every write route calls.
 */
export function requireUser(currentUser: User | null): User {
  if (!currentUser) throw new AuthenticationError();
  return currentUser;
}
