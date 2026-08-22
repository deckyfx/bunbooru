import { applyCoreMigrations, createCoreRuntime, createLogMailProvider } from "@bunbooru/core";

import { envConfig, MAX_REQUEST_BODY_BYTES } from "./env-config";
import { logger } from "./lib/logger";
import { createPluginHost } from "./plugins/host";
import { loadPlugins } from "./plugins/loader";
import { PLUGIN_REGISTRY } from "./plugins/registry";
import { createApp } from "./server";

/**
 * `@bunbooru/api` — the REST API composition root.
 *
 * Assembles the Core (db → repositories → services) from runtime config, loads
 * the enabled plugins over the SAME db handle (running their migrations, then
 * `register`), builds the HTTP app, mounts plugin routes, and serves it.
 */
const isProduction = envConfig.NODE_ENV === "production";

// Public base URL for links in outgoing mail. In dev it defaults to localhost so
// reset/verify are testable with zero config; in production it must be set
// explicitly whenever a mail provider is active (enforced after plugins load).
// Never derived from the request `Host` header (host-header injection is the
// classic password-reset vulnerability).
const publicBaseUrl =
  envConfig.PUBLIC_BASE_URL ?? (isProduction ? null : `http://localhost:${envConfig.SERVER_PORT}`);

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

// Install the mail transport a plugin supplies. Fail fast if two plugins both
// register one — silent last-wins would route mail out an unintended transport.
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
const mailPlugin = mailPlugins[0];
if (mailPlugin) {
  core.mailService.setProvider(mailPlugin.mailProvider, mailPlugin.id);
} else if (!isProduction) {
  // Dev/testing convenience: a log-only provider so the reset/verify flows are
  // exercisable end-to-end with zero mail configuration (doc §6).
  core.mailService.setProvider(createLogMailProvider(logger), "core:log-only");
}

// A configured mail provider needs an absolute link origin. Enforce it now that
// we know whether mail is active — a boot-time failure beats a silent one at the
// first reset email.
if (core.mailService.isConfigured() && !publicBaseUrl) {
  throw new Error(
    "PUBLIC_BASE_URL is required when a mail provider is active (set it to the site's absolute URL).",
  );
}

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
});
await pluginHost.init();

const app = createApp({ core, host: pluginHost });

// Mount each plugin's routes under its `/api/v1/plugins/<id>` prefix. Done here
// (not inside `createApp`) so the exported `App` type stays Core-only — plugin
// routes are consumed via each plugin's own exported app type on the web. The
// host's `onRequest` gate 404s routes of inactive plugins.
for (const p of loadedPlugins) {
  if (p.routes) app.use(p.routes);
}

app.listen(
  { port: envConfig.SERVER_PORT, maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
  (server) => {
    logger.info("server_started", {
      url: `http://${server.hostname}:${server.port}`,
      env: envConfig.NODE_ENV,
    });
  },
);

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
    await app.stop();
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

export type { ApiKeyDto, App, AssetDto, TagDto, UploadLimitsDto, UserDto } from "./server";
export type { ExtensionInfo as ExtensionDto } from "./plugins/host";
