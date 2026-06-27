import { CORE_DEPENDENCIES } from "@bunbooru/core";
import { DB_PACKAGE } from "@bunbooru/db";

/**
 * `@bunbooru/auth` — session-based authentication and the permission model.
 *
 * Sign-in creates a server-side session row and sets an `httpOnly` cookie;
 * no token is exposed to JavaScript. Resolves a request's identity and
 * permissions for Services. Implementation lands in a later PR.
 */
export const AUTH_PACKAGE = "@bunbooru/auth" as const;

/** Internal packages auth composes over. */
export const AUTH_DEPENDENCIES = [...CORE_DEPENDENCIES, DB_PACKAGE] as const;
