import type { HTMLBundle } from "bun";

import { applyCoreMigrations, createCoreRuntime, createLogMailProvider } from "@bunbooru/core";

import { envConfig, MAX_REQUEST_BODY_BYTES } from "./env-config";
import { logger } from "./lib/logger";
import { mailBinding, searchBinding } from "./plugins/capability-bindings";
import { createPluginHost } from "./plugins/host";
import { loadPlugins } from "./plugins/loader";
import { PLUGIN_REGISTRY } from "./plugins/registry";
import { createApp } from "./server";
import { WEB_ASSETS } from "./web/embedded-assets";
import { createWebRoutes } from "./web/routes";

/** How {@link startApi} is being launched. */
export interface StartOptions {
  /**
   * One-port development only (`scripts/dev.ts`): the web app's HTML entry,
   * served from this server with Bun's bundler and hot reload. Absent in
   * production (the binary serves the embedded build) and in API-only dev.
   */
  devWeb?: HTMLBundle;
}

// Never reclaim a blob written within this window — its row insert may simply
// not have landed yet (the store→insert gap is milliseconds, so 1h is ample).
const ORPHAN_GC_GRACE_MS = 60 * 60 * 1000;

/**
 * Drive an idempotent background sweep every `intervalMs` (`<= 0` disables it).
 * Failures are isolated (logged, never thrown), the count is logged when > 0,
 * and the timer is `unref()`'d so it never keeps the process alive. Returns the
 * timer so shutdown can clear it.
 */
function startSweep(
  intervalMs: number,
  label: string,
  run: () => Promise<number>,
): ReturnType<typeof setInterval> | undefined {
  if (intervalMs <= 0) return undefined;
  // Guard against overlap: a slow sweep (e.g. a full-store orphan scan) must not
  // have a second run start on top of it. The async wrapper also turns a
  // synchronous throw from `run()` into a rejection we actually catch.
  let inFlight = false;
  const sweep = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const removed = await run();
      if (removed > 0) logger.info(`${label}_swept`, { removed });
    } catch (error) {
      logger.error(`${label}_failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  return timer;
}

/**
 * Boot the API: assemble Core from runtime config, apply migrations, load the
 * plugins over the SAME db handle (running their migrations, then `register`),
 * build the HTTP app, mount plugin and web routes, listen, and start the
 * background sweeps. Installs SIGTERM/SIGINT handlers for a clean shutdown.
 * Called by `index.ts` (normal start, and the production binary) and by
 * `scripts/dev.ts` (one-port development).
 */
export async function startApi(options: StartOptions = {}): Promise<void> {
  const isProduction = envConfig.NODE_ENV === "production";

  // Public base URL for links in outgoing mail. In dev it defaults to localhost so
  // reset/verify are testable with zero config; in production it must be set
  // explicitly whenever a mail provider is active (enforced after plugins load).
  // Never derived from the request `Host` header (host-header injection is the
  // classic password-reset vulnerability).
  // The dev fallback targets the WEB dev server, not this API. In production the
  // API serves the built SPA on its own origin, so SERVER_PORT would be right —
  // but the fallback only ever applies in development, where the two run on
  // separate ports (web 3001 proxies /api/* to api 3000). Pointing it at
  // SERVER_PORT produced reset links to :3000/reset-password, which the API has no
  // route for and answers with a JSON 404.
  //
  // With the one-port dev launcher (`devWeb`), the web app is served from this
  // API's own port, so the fallback targets SERVER_PORT instead.
  const publicBaseUrl =
    envConfig.PUBLIC_BASE_URL ??
    (isProduction
      ? null
      : `http://localhost:${options.devWeb ? envConfig.SERVER_PORT : envConfig.WEB_PORT}`);

  const { core, db, storage } = createCoreRuntime({
    databaseUrl: envConfig.DATABASE_URL,
    storageRoot: envConfig.STORAGE_ROOT,
    // Env values are the DEFAULTS; an admin can override the caps at runtime.
    maxUploadBytes: envConfig.MAX_UPLOAD_BYTES,
    maxResumableUploadBytes: envConfig.MAX_RESUMABLE_UPLOAD_BYTES,
    requestBodyCeilingBytes: MAX_REQUEST_BODY_BYTES,
    sessionExpiryMs: envConfig.SESSION_EXPIRY_MS,
    publicBaseUrl,
    requireVerifiedEmailForReset: envConfig.REQUIRE_VERIFIED_EMAIL_FOR_RESET,
  });

  // Apply any pending CORE migrations before serving, so adding a migration takes
  // effect on the next boot with no manual step (plugin migrations already
  // auto-apply in loadPlugins). Runs on the shared handle; idempotent.
  await applyCoreMigrations(envConfig.DATABASE_URL);
  logger.info("core_migrations_applied", {});

  // Load ALL known plugins before building the app: their migrations run here and
  // their routes get mounted, so runtime activation is a pure in-memory/DB flip (no
  // route surgery) and routes still inherit the root app's auth/error handling. The
  // plugin host gates inactive plugins; `ENABLED_PLUGINS` only seeds the active set
  // on first boot. (Top-level await is safe — the production build has no bytecode.)
  const loadedPlugins = await loadPlugins({
    core,
    db,
    storage,
    enabledIds: Object.keys(PLUGIN_REGISTRY),
  });

  // A plugin's mail transport is a CAPABILITY that follows its active state — the
  // plugin host installs it on activate and removes it on deactivate (see the
  // binding below), so deactivating mail immediately 503s the reset/verify flows
  // instead of lingering until a restart. Fail fast if two plugins provide one.
  const mailPlugins = loadedPlugins.filter(
    (p): p is typeof p & { mailProvider: NonNullable<typeof p.mailProvider> } =>
      p.mailProvider !== undefined,
  );
  if (mailPlugins.length > 1) {
    throw new Error(
      `Multiple plugins registered a mail provider: ${mailPlugins.map((p) => p.id).join(", ")}. ` +
        "Enable only one.",
    );
  }
  // Dev/testing convenience: with NO mail plugin installed at all, a log-only
  // provider keeps the reset/verify flows exercisable with zero configuration.
  if (mailPlugins.length === 0 && !isProduction) {
    core.mailService.setProvider(createLogMailProvider(logger), "core:log-only");
  }
  // A mail provider needs an absolute link origin. Require PUBLIC_BASE_URL up front
  // whenever a mail plugin is INSTALLED (an admin may activate it at runtime), not
  // only when active — a boot-time failure beats a silent one at first send.
  if (mailPlugins.length > 0 && !publicBaseUrl) {
    throw new Error(
      "PUBLIC_BASE_URL is required when a mail-provider plugin is installed (set it to the site's absolute URL).",
    );
  }

  // Capability bindings: what a plugin supplies to Core (its mail transport,
  // its search metatags), installed on activate and removed on deactivate.
  // Future per-plugin capabilities add a binding there, not logic in the host.
  const capabilityBindings = [mailBinding(core.mailService), searchBinding(core.searchProviders)];

  // Record every loaded plugin's owned tables in the catalog in ONE atomic write
  // (so a partial failure can't leave it half-written) — this is how the admin
  // console shows which table belongs to which plugin.
  await core.pluginCatalogService.recordAll(
    loadedPlugins.map((p) => ({ pluginId: p.id, tables: p.tables })),
  );

  const pluginHost = createPluginHost({
    pluginState: core.pluginStateService,
    loaded: loadedPlugins,
    seedActiveIds: envConfig.ENABLED_PLUGINS,
    capabilityBindings,
  });
  // init() installs the capabilities of every already-active plugin (e.g. the mail
  // provider) — so the mail flows reflect the persisted active set from boot.
  await pluginHost.init();

  const app = createApp({ core, host: pluginHost, storage, publicBaseUrl });

  // Mount each plugin's routes under its `/api/v1/plugins/<id>` prefix. Done here
  // (not inside `createApp`) so the exported `App` type stays Core-only — plugin
  // routes are consumed via each plugin's own exported app type on the web. The
  // host's `onRequest` gate 404s routes of inactive plugins.
  for (const p of loadedPlugins) {
    if (p.routes) app.use(p.routes);
  }

  // The web SPA, from the files compiled into the production binary: one process,
  // one port, same origin (so no CORS). From source WEB_ASSETS is empty and this
  // mounts nothing; in dev the web server on WEB_PORT serves the SPA and proxies
  // `/api/*` here. Its catch-all ranks below every concrete route, so mounting it
  // last is for readability, not correctness.
  app.use(createWebRoutes(WEB_ASSETS));
  logger.info("web_spa", { embedded: WEB_ASSETS.length > 0, files: WEB_ASSETS.length });

  const logStarted = (server: { hostname?: string; port?: number }): void => {
    logger.info("server_started", {
      url: `http://${server.hostname}:${server.port}`,
      env: envConfig.NODE_ENV,
    });
  };

  // Production, and API-only dev: Elysia serves everything itself.
  // One-port dev (scripts/dev.ts): Bun.serve directly, so Bun's own `routes`
  // serve the web app's HTML entry (bundled on the fly, with hot reload) while
  // the API paths go to the Elysia app. Elysia can't do this itself: with global
  // hooks registered it handles an HTMLBundle route as a plain value (JSON
  // `{}`), and its `listen()` overwrites a `routes` option. Attaching the Bun
  // server keeps `server.requestIP()` (the rate limiter's client IP) working.
  let stopServer: () => Promise<void>;
  if (options.devWeb) {
    const toApi = (request: Request) => app.handle(request);
    const server = Bun.serve({
      port: envConfig.SERVER_PORT,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      development: { hmr: true, console: true },
      routes: { "/api/*": toApi, "/health": toApi, "/*": options.devWeb },
      fetch: toApi,
    });
    app.server = server;
    stopServer = () => server.stop();
    logger.info("web_dev", { hmr: true });
    logStarted(server);
  } else {
    app.listen({ port: envConfig.SERVER_PORT, maxRequestBodySize: MAX_REQUEST_BODY_BYTES }, logStarted);
    stopServer = async () => {
      await app.stop();
    };
  }

  // Two cadences: expired upload sessions + their staging files get swept often
  // (cheap), while orphaned asset blobs get a slow sweep (a full store scan).
  const sweepTimers = [
    startSweep(envConfig.UPLOAD_GC_INTERVAL_MS, "upload_gc", () => core.uploadService.gcExpired()),
    startSweep(envConfig.ASSET_ORPHAN_GC_INTERVAL_MS, "asset_orphan_gc", () =>
      core.assetService.gcOrphanedBlobs(new Date(Date.now() - ORPHAN_GC_GRACE_MS)),
    ),
    // Expired login sessions are pure housekeeping (the lookup already filters on
    // expiry), so this runs on a slow cadence.
    startSweep(envConfig.SESSION_GC_INTERVAL_MS, "session_gc", () =>
      core.authService.gcExpiredSessions(new Date()),
    ),
    // Expired reset/verify tokens are pure housekeeping (a consume already rejects
    // expired ones), so this shares the session GC cadence.
    startSweep(envConfig.SESSION_GC_INTERVAL_MS, "auth_token_gc", () =>
      core.authService.gcExpiredTokens(new Date()),
    ),
  ].filter((t): t is ReturnType<typeof setInterval> => t !== undefined);

  /** Stop the server cleanly so `docker stop` (SIGTERM) drains in-flight requests. */
  const shutdown = async (): Promise<void> => {
    logger.info("server_stopping", {});
    for (const timer of sweepTimers) clearInterval(timer);
    try {
      await stopServer();
      process.exit(0);
    } catch (error) {
      logger.error("server_stop_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };
  // `once` so a repeated/second signal can't launch a duplicate shutdown.
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
