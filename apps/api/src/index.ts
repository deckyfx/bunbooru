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

/** Stop the server cleanly so `docker stop` (SIGTERM) drains in-flight requests. */
const shutdown = async (): Promise<void> => {
  logger.info("server_stopping", {});
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
