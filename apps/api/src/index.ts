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
  maxUploadBytes: envConfig.MAX_UPLOAD_BYTES,
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

// Periodically reclaim expired upload sessions + their staging files. Without
// this, abandoned sessions only get swept opportunistically when the next upload
// begins. `gcExpired()` is idempotent and self-contained — we just drive it on a
// timer, isolate failures, and `unref()` so it never keeps the process alive.
const gcIntervalMs = envConfig.UPLOAD_GC_INTERVAL_MS;
const gcTimer =
  gcIntervalMs > 0
    ? setInterval(() => {
        void core.uploadService
          .gcExpired()
          .then((removed) => {
            if (removed > 0) logger.info("upload_gc_swept", { removed });
          })
          .catch((error) => {
            logger.error("upload_gc_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, gcIntervalMs)
    : undefined;
gcTimer?.unref();

/** Stop the server cleanly so `docker stop` (SIGTERM) drains in-flight requests. */
const shutdown = async (): Promise<void> => {
  logger.info("server_stopping", {});
  if (gcTimer) clearInterval(gcTimer);
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

export type { App, AssetDto } from "./server";
