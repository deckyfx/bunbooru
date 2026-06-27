import { AUTH_PACKAGE } from "@bunbooru/auth";
import { CORE_DEPENDENCIES } from "@bunbooru/core";
import { PLUGIN_SDK_VERSION } from "@bunbooru/plugin-sdk";

/**
 * `@bunbooru/api` — the REST API composition root.
 *
 * As an app it may depend on anything inward. It wires Core, auth, and enabled
 * plugins together and exposes HTTP. The Elysia server, routes, validation, and
 * plugin loader land in later PRs — this entrypoint is intentionally inert.
 */
export const API_BOOT = {
  core: CORE_DEPENDENCIES,
  auth: AUTH_PACKAGE,
  sdk: PLUGIN_SDK_VERSION,
} as const;
