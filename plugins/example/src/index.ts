import { PLUGIN_SDK_VERSION } from "@bunbooru/plugin-sdk";

/**
 * Example feature module.
 *
 * Exists to demonstrate the `plugins → plugin-sdk` boundary: a plugin imports
 * ONLY from `@bunbooru/plugin-sdk`. The real registration shape (routes,
 * tables, events, permissions) lands once the SDK API exists.
 */
export const plugin = {
  id: "example",
  /** SDK version this module was built against. */
  sdk: PLUGIN_SDK_VERSION,
} as const;
