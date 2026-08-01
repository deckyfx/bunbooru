import type { ComponentType } from "react";

import { ExampleSection } from "./example/ExampleSection";
import { ThumbnailsSection } from "./thumbnailer/ThumbnailsSection";

/**
 * Web admin UI for plugins, keyed by plugin id.
 *
 * A plugin's backend (routes, tables) lives in its own package, but its admin
 * UI lives here in the app — a plugin can't import the app's Eden client, router,
 * or styles (`plugins → apps` is forbidden). The admin console renders the
 * section for each enabled plugin (from `GET /api/v1/plugins`) that has an entry
 * here; an enabled plugin without one simply has no admin UI in this build.
 */
export const PLUGIN_ADMIN_SECTIONS: Record<string, ComponentType> = {
  example: ExampleSection,
  thumbnailer: ThumbnailsSection,
};
