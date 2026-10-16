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
  "post-detail-aside": [],
};

/** Plugin links in the site menus (header and home page), to the plugin's pages. */
export const PLUGIN_NAV: readonly PluginNavLink[] = [];
