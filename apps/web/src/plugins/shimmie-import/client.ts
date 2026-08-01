import { treaty } from "@elysiajs/eden";

import type { ShimmieImportPluginApp } from "@bunbooru/plugin-shimmie-import";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the shimmie-import plugin's admin routes. Built from the
 * plugin's own exported {@link ShimmieImportPluginApp} type; paths include the
 * `/api/v1/plugins/shimmie-import` prefix.
 */
export const shimmieImportApi = treaty<ShimmieImportPluginApp>(treatyOrigin, treatyOptions);
