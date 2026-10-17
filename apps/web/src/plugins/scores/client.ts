import { treaty } from "@elysiajs/eden";

import type { ScoresPluginApp } from "@bunbooru/plugin-scores";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the scores plugin's routes, built from the plugin's
 * own exported {@link ScoresPluginApp} type (paths include the
 * `/api/v1/plugins/scores` prefix).
 */
export const scoresApi = treaty<ScoresPluginApp>(treatyOrigin, treatyOptions);
