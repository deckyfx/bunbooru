import { envConfig } from "./env-config";
import { logger } from "./lib/logger";
import { app } from "./server";

/**
 * `@bunbooru/api` — the REST API composition root.
 *
 * Wires Core, auth, and enabled plugins together and serves HTTP. For now it
 * starts the bare Elysia app; the Drizzle connection, auth middleware, and
 * plugin loader attach here in later PRs.
 */
app.listen(envConfig.SERVER_PORT, (server) => {
  logger.info("server_started", {
    url: `http://${server.hostname}:${server.port}`,
    env: envConfig.NODE_ENV,
  });
});

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

export type { App } from "./server";
