/**
 * One-port development: the API and the web app on a single server.
 *
 * Imports the web app's HTML entry (Bun bundles it on the fly, with hot reload)
 * and hands it to the API's own boot, which serves it alongside `/api/v1` from
 * SERVER_PORT (default 3000), the same shape as the production binary. The two
 * apps stay separate projects: only this launcher, outside both, imports each.
 *
 * Run with `bun run dev`. Server-side changes restart the process (`--watch`);
 * web changes hot-reload in the browser. Tailwind is applied to the dev bundle
 * through the root bunfig.toml's `[serve.static]` plugins.
 *
 * The two-server setup is still available: `bun run dev:api` (API only) plus
 * `bun run dev:web` (web on WEB_PORT, proxying `/api/*`).
 */
import web from "../apps/web/src/index.html";
import { startApi } from "../apps/api/src/start";

await startApi({ devWeb: web });
