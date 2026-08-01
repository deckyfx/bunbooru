import { treaty } from "@elysiajs/eden";

import type { ThumbnailerPluginApp } from "@bunbooru/plugin-thumbnailer";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the thumbnailer plugin's admin routes (`/status`,
 * `/backfill`). Built from the plugin's own exported {@link ThumbnailerPluginApp}
 * type; paths include the `/api/v1/plugins/thumbnailer` prefix. The public thumb
 * URL is a plain string (`assetThumbUrl` in `lib/api`), used as an `<img src>`.
 */
export const thumbnailerApi = treaty<ThumbnailerPluginApp>(treatyOrigin, treatyOptions);
