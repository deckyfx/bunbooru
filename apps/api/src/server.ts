import { Elysia } from "elysia";

import { CORE_PACKAGE } from "@bunbooru/core";
import { PLUGIN_SDK_VERSION } from "@bunbooru/plugin-sdk";

import { envConfig } from "./env-config";
import { logger } from "./lib/logger";
import { readRequestId, safeMessage, statusFor } from "./lib/http";

/**
 * The Bunbooru API application.
 *
 * Defined separately from the listen call so it can be imported by tests and by
 * the Eden Treaty client via the exported {@link App} type. API routes are
 * versioned under `/api/v1`; the plugin loader, validation, and real endpoints
 * land in later PRs.
 *
 * Cross-cutting concerns wired here so every endpoint inherits them:
 * a per-request id (echoed as `x-request-id`), structured request logging, and
 * a global error handler that never leaks stack traces.
 */
export const app = new Elysia()
  // Stamp every request (matched or not, so 404s are covered too) with an id,
  // echoed back as `x-request-id`. Propagate a caller/proxy-supplied id when it
  // looks sane (so traces correlate end-to-end); otherwise generate one. The
  // length cap bounds untrusted input flowing into logs/headers.
  .onRequest(({ request, set }) => {
    const incoming = request.headers.get("x-request-id");
    set.headers["x-request-id"] =
      incoming && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : crypto.randomUUID();
  })
  // Expose the id + a start time to handlers on matched routes.
  .derive(({ set }) => ({
    requestId: readRequestId(set.headers),
    startedAt: performance.now(),
  }))
  // Safe, typed error responses. Stack traces are never returned, and 5xx
  // messages are generic outside development.
  .onError(({ code, error, set, path, request }) => {
    const status = statusFor(code, error);
    set.status = status;

    const requestId = readRequestId(set.headers);
    const detail = error instanceof Error ? error.message : String(error);

    logger.error("request_failed", {
      requestId,
      method: request.method,
      path,
      code,
      status,
      detail,
    });

    return {
      error: { message: safeMessage(status, detail, envConfig.isDevelopment), requestId },
    };
  })
  // Structured access log after each response is sent.
  .onAfterResponse((ctx) => {
    const { request, set, path } = ctx;
    const startedAt = "startedAt" in ctx ? (ctx.startedAt as number) : undefined;
    logger.info("request", {
      requestId: readRequestId(set.headers),
      method: request.method,
      path,
      status: set.status,
      durationMs:
        startedAt === undefined ? undefined : Math.round(performance.now() - startedAt),
    });
  })
  .get("/", () => ({
    name: CORE_PACKAGE,
    sdk: PLUGIN_SDK_VERSION,
    status: "ok",
  }))
  // Unversioned, stable probe for orchestrators (Docker HEALTHCHECK, k8s).
  // Kept outside `/api/v1` so it never moves when the API version changes.
  .get("/health", () => ({ status: "ok" as const }))
  .group("/api/v1", (api) =>
    api.get("/health", () => ({ status: "ok" as const })),
  );

/** Server type for end-to-end type safety with the Eden Treaty client. */
export type App = typeof app;
