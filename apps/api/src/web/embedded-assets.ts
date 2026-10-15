import type { WebAsset } from "./routes";

/**
 * The web SPA files compiled into this executable.
 *
 * Empty when running from source (dev / tests): there the web app is served by
 * its own dev server, which proxies `/api/*` here. `apps/api/build.ts` REPLACES
 * this module's contents at compile time with a generated manifest that imports
 * every built SPA file `with { type: "file" }`, which embeds them in the binary.
 * Keep the export's name and type stable: the generated module must match it.
 */
export const WEB_ASSETS: readonly WebAsset[] = [];
