import { lazy } from "react";

import type { PluginNavLink, PluginUiRegistry } from "./slots";

/**
 * Every plugin's web UI, by slot. A plugin's backend (routes, tables) lives in
 * its own package, but its UI lives here in the app: a plugin can't import the
 * app's Eden client, router, or styles (`plugins → apps` is forbidden). An
 * entry renders only while its plugin is active (`GET /api/v1/plugins`), so an
 * enabled plugin with no entry in this build simply shows nothing.
 *
 * Widgets are lazy-loaded: a deployment running two plugins doesn't ship the
 * UI of the others in its main bundle.
 */
export const PLUGIN_UI: PluginUiRegistry = {
  admin: [
    {
      pluginId: "banned-hashes",
      id: "bans",
      title: "Banned hashes",
      component: lazy(() =>
        import("./banned-hashes/BannedHashesSection").then((m) => ({ default: m.BannedHashesSection })),
      ),
    },
    {
      pluginId: "example",
      id: "pings",
      title: "Example: Pings",
      component: lazy(() => import("./example/ExampleSection").then((m) => ({ default: m.ExampleSection }))),
    },
    {
      pluginId: "shimmie-import",
      id: "import",
      title: "Import from Shimmie",
      component: lazy(() =>
        import("./shimmie-import/ShimmieImportSection").then((m) => ({ default: m.ShimmieImportSection })),
      ),
    },
    {
      pluginId: "smtp-mailer",
      id: "settings",
      title: "Email (SMTP)",
      component: lazy(() =>
        import("./smtp-mailer/SmtpMailerSection").then((m) => ({ default: m.SmtpMailerSection })),
      ),
    },
    {
      pluginId: "thumbnailer",
      id: "thumbnails",
      title: "Thumbnails",
      component: lazy(() =>
        import("./thumbnailer/ThumbnailsSection").then((m) => ({ default: m.ThumbnailsSection })),
      ),
    },
  ],
  "post-detail-aside": [
    {
      pluginId: "favorites",
      id: "button",
      title: "Favorites",
      component: lazy(() => import("./favorites/FavoriteButton").then((m) => ({ default: m.FavoriteButton }))),
    },
    {
      pluginId: "pools",
      id: "nav",
      title: "Pools",
      order: 10,
      component: lazy(() => import("./pools/PoolNav").then((m) => ({ default: m.PoolNav }))),
    },
    {
      pluginId: "banned-hashes",
      id: "ban",
      title: "File ban",
      order: 100,
      visibility: "moderator",
      component: lazy(() => import("./banned-hashes/BanFileButton").then((m) => ({ default: m.BanFileButton }))),
    },
  ],
};

/** Plugin links in the site menus (header and home page), to the plugin's pages. */
export const PLUGIN_NAV: readonly PluginNavLink[] = [
  { pluginId: "favorites", label: "Favorites", to: "/favorites", visibility: "member" },
  { pluginId: "pools", label: "Pools", to: "/pools" },
];

/**
 * Plugin-owned pages, lazy-loaded like the widgets. Their routes are declared
 * in `router.tsx` (so links to them stay typed), each wrapped in a
 * `PluginPage` that shows not-found while the plugin is inactive.
 */
export const PLUGIN_PAGES = {
  favorites: lazy(() => import("./favorites/FavoritesPage").then((m) => ({ default: m.FavoritesPage }))),
  pools: lazy(() => import("./pools/PoolsPage").then((m) => ({ default: m.PoolsPage }))),
  pool: lazy(() => import("./pools/PoolPage").then((m) => ({ default: m.PoolPage }))),
};
