import type { BunbooruPlugin } from "@bunbooru/plugin-sdk";

/** The module shape every plugin package exports: a `plugin` default member. */
export interface PluginModule {
  plugin: BunbooruPlugin;
}

/**
 * The registry of known first-party plugins, keyed by id.
 *
 * Each entry is a lazy dynamic `import()` so a plugin's module code only runs
 * when it is enabled (see `ENABLED_PLUGINS`). Adding a plugin means: add its
 * package as a dependency of `@bunbooru/api`, then add one line here. The loader
 * imports only the enabled ids — an unknown id is logged and skipped.
 */
export const PLUGIN_REGISTRY: Record<string, () => Promise<PluginModule>> = {
  example: () => import("@bunbooru/plugin-example"),
  thumbnailer: () => import("@bunbooru/plugin-thumbnailer"),
};
