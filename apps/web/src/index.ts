import { serve } from "bun";

import index from "./index.html";

/** Web dev/serve port (default 3001 so it can run alongside the API on 3000). */
const port = Number(Bun.env.WEB_PORT ?? "3001") || 3001;
/** Bind all interfaces by default so the dev server is reachable on the LAN. */
const hostname = Bun.env.WEB_HOST ?? "0.0.0.0";
/** Enable Bun's dev bundling/HMR unless explicitly in production. */
const development = Bun.env.NODE_ENV !== "production";

/**
 * Serve the single-page app. Every route returns `index.html`; the client
 * router takes over, and Bun bundles `index.tsx` + assets (Tailwind via
 * bun-plugin-tailwind from bunfig.toml).
 */
const server = serve({
  port,
  hostname,
  development,
  routes: {
    "/*": index,
  },
});

console.log(`🐇 Bunbooru web on ${server.url}`);
