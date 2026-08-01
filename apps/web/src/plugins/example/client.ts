import { treaty } from "@elysiajs/eden";

import type { ExamplePluginApp } from "@bunbooru/plugin-example";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the example plugin's routes. Built from the plugin's own
 * exported {@link ExamplePluginApp} type (a plugin can't import the core `api`
 * client — `plugins → apps` is forbidden — so the web owns the client). Paths
 * include the `/api/v1/plugins/example` prefix baked into the plugin's app.
 */
export const exampleApi = treaty<ExamplePluginApp>(treatyOrigin, treatyOptions);
