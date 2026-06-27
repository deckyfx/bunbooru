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
  await app.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

export type { App } from "./server";
