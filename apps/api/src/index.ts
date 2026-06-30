import { createCore } from "@bunbooru/core";

import { envConfig, MAX_REQUEST_BODY_BYTES } from "./env-config";
import { logger } from "./lib/logger";
import { createApp } from "./server";

/**
 * `@bunbooru/api` — the REST API composition root.
 *
 * Assembles the Core (db → repositories → services) from runtime config and
 * builds the HTTP app over it, then serves it. Auth middleware and the plugin
 * loader attach here in later PRs.
 */
const core = createCore({
  databaseUrl: envConfig.DATABASE_URL,
  storageRoot: envConfig.STORAGE_ROOT,
  maxResumableUploadBytes: envConfig.MAX_RESUMABLE_UPLOAD_BYTES,
});
const app = createApp({ core, maxUploadBytes: envConfig.MAX_UPLOAD_BYTES });

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

export type { App, AssetDto, TagDto } from "./server";
