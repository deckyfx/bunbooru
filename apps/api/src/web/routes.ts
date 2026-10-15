import { Elysia, NotFoundError } from "elysia";

/** One embedded SPA file: the URL it is served at and where it lives in the binary. */
export interface WebAsset {
  /** Request path, e.g. `/index.html` or `/chunk-x.js`. */
  urlPath: string;
  /** Path `Bun.file` can open: `/$bunfs/…` in a compiled binary, a real path in tests. */
  file: string;
  /**
   * Whether the URL itself names the content (the bundler put the file's hash in
   * its name), so it may be cached forever. Recorded by the build from the
   * bundler's own output, never inferred here from the name's shape.
   */
  immutable: boolean;
}

/** The SPA shell, answered for every client-side route. */
const INDEX_PATH = "/index.html";

/** A content-hashed URL never changes meaning, so browsers may keep it forever. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/**
 * Anything with a stable URL must be revalidated on every load: `index.html`
 * names the current chunks, and any other stable name could change content in
 * the next deploy.
 */
const REVALIDATE_CACHE = "no-cache";

/** Paths the SPA must never answer: an unknown API route is a 404, not HTML. */
const API_PREFIX = /^\/api(?:\/|$)/;
/**
 * A request for a bundler output that isn't embedded, e.g. `/chunk-stale.js`.
 * Deliberately limited to the file types the build emits, not "any extension":
 * a client route may legitimately end in a dotted segment (tag names like `k.o`
 * or `st._louis`), and that must still get the SPA.
 */
const ASSET_FILE = /\.(?:js|mjs|css|map|html|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf)$/i;

/** Serve one embedded file with its cache policy. */
function serveFile(file: string, cacheControl: string): Response {
  // Bun.file infers Content-Type from the extension.
  return new Response(Bun.file(file), {
    headers: { "cache-control": cacheControl, "x-content-type-options": "nosniff" },
  });
}

/**
 * Routes that serve the embedded web SPA from the same origin and port as the
 * API (production single-binary mode). Returns an empty plugin when `assets` is
 * empty, which is the case when running from source.
 *
 * One catch-all GET route, so registration order doesn't matter: Elysia ranks
 * every concrete route (`/api/v1/…`, `/health`, plugin routes) above a wildcard.
 * The catch-all then answers, in order:
 * - an embedded file at that exact path, cached forever only if its name is
 *   content-hashed;
 * - a 404 for `/api/…`, so a typo in an API path stays a JSON error, never HTML;
 * - a 404 for a missing asset (`/old-chunk.js`), so a stale reference fails
 *   clearly instead of being parsed as HTML;
 * - otherwise `index.html`, and the client router takes over (`/posts/12`).
 *
 * Mount it on the root app (after `createApp`) so the root's error handler
 * formats those 404s like every other API error.
 */
export function createWebRoutes(assets: readonly WebAsset[]) {
  const plugin = new Elysia({ name: "web-spa" });
  const byPath = new Map(assets.map((asset) => [asset.urlPath, asset]));
  const shell = byPath.get(INDEX_PATH)?.file;
  if (!shell) {
    if (assets.length > 0) {
      throw new Error(`Embedded web assets are missing ${INDEX_PATH}.`);
    }
    return plugin; // running from source: the web dev server owns the SPA
  }

  return plugin.get("/*", ({ path }) => {
    const asset = byPath.get(path);
    if (asset) return serveFile(asset.file, asset.immutable ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    if (API_PREFIX.test(path) || ASSET_FILE.test(path)) throw new NotFoundError();
    return serveFile(shell, REVALIDATE_CACHE);
  });
}
