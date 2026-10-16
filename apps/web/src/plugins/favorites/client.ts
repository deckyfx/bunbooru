import { treaty } from "@elysiajs/eden";

import type { FavoritesPluginApp } from "@bunbooru/plugin-favorites";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the favorites plugin's routes, built from the plugin's
 * own exported {@link FavoritesPluginApp} type (paths include the
 * `/api/v1/plugins/favorites` prefix).
 */
export const favoritesApi = treaty<FavoritesPluginApp>(treatyOrigin, treatyOptions);
