import { CORE_PACKAGE } from "@bunbooru/core";
import { DB_PACKAGE } from "@bunbooru/db";

/**
 * `@bunbooru/auth` — session-based authentication and the permission model.
 *
 * Sign-in creates a server-side session row and sets an `httpOnly` cookie;
 * no token is exposed to JavaScript. Resolves a request's identity and
 * permissions for Services. Implementation lands in a later PR.
 */
export const AUTH_PACKAGE = "@bunbooru/auth" as const;

/** Internal packages auth composes over — mirrors this package's dependencies. */
export const AUTH_DEPENDENCIES = [CORE_PACKAGE, DB_PACKAGE] as const;
