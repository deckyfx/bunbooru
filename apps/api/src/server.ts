import { Elysia, t } from "elysia";

import { CORE_PACKAGE, MAX_PER_PAGE, type Asset, type AssetUpdate, type Core } from "@bunbooru/core";
import { PLUGIN_SDK_VERSION } from "@bunbooru/plugin-sdk";

import { envConfig } from "./env-config";
import { HttpError } from "./lib/errors";
import { logger } from "./lib/logger";
import { readRequestId, safeMessage, statusFor } from "./lib/http";

/** Runtime collaborators the app is built over — injected so tests can stub them. */
export interface AppDependencies {
  /** Assembled Core services (see `createCore` in `@bunbooru/core`). */
  core: Core;
  /** Reject uploads larger than this many bytes (logged, then 413). */
  maxUploadBytes: number;
}

/**
 * Wire shape of an asset. Timestamps are ISO strings (Drizzle hands back `Date`,
 * which JSON-serializes to a string), so the Eden Treaty client infers the exact
 * over-the-wire types rather than a `Date` it will never actually receive.
 */
export type AssetDto = Omit<Asset, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

/** Accepted rating values on write — mirrors the DB `rating` enum (incl. `unrated`). */
const ratingSchema = t.Union([
  t.Literal("unrated"),
  t.Literal("safe"),
  t.Literal("questionable"),
  t.Literal("explicit"),
]);

/** Source URL/text — capped, and nullable so a client can explicitly clear it. */
const sourceSchema = t.Union([t.String({ maxLength: 2048 }), t.Null()]);

/** Asset id path param, shared by the `/assets/:id*` routes. */
const idParam = t.Object({
  id: t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }),
});

/** Upload-session token path param (bounded; storage layer also guards traversal). */
const tokenParam = t.Object({ token: t.String({ maxLength: 100 }) });

/** Project a domain {@link Asset} onto its JSON wire form. */
function serializeAsset(asset: Asset): AssetDto {
  return {
    ...asset,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

/**
 * Build the Bunbooru API application over its {@link AppDependencies}.
 *
 * A factory (rather than a module-level singleton) so the composition root
 * injects the real, database-backed Core while tests inject a stub — no test
 * needs a live Postgres to exercise routing, middleware, or error handling. The
 * returned app is consumed by the Eden Treaty client via the {@link App} type.
 *
 * Cross-cutting concerns wired here so every endpoint inherits them: a
 * per-request id (echoed as `x-request-id`), structured request logging, and a
 * global error handler that never leaks stack traces. API routes are versioned
 * under `/api/v1`.
 */
export function createApp({ core, maxUploadBytes }: AppDependencies) {
  return new Elysia()
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
      api
        .get("/health", () => ({ status: "ok" as const }))
        // Newest-first page of assets. `page`/`per_page` are coerced and
        // range-checked here; the service clamps defensively as well.
        .get(
          "/assets",
          async ({ query }) => {
            const page = await core.assetService.list({
              page: query.page,
              perPage: query.per_page,
              query: query.q,
            });
            return { ...page, assets: page.assets.map(serializeAsset) };
          },
          {
            query: t.Object({
              // Booru search query (tags + metatags); Core compiles it to SQL.
              q: t.Optional(t.String({ maxLength: 1024 })),
              // Integer-only (`multipleOf: 1`): reject fractional page sizes at
              // the boundary so offset/limit math is never ambiguous. The upper
              // bound keeps (page-1)*perPage within MAX_SAFE_INTEGER so a huge
              // page can't overflow the offset into a 5xx (the service caps too).
              page: t.Optional(
                t.Numeric({
                  minimum: 1,
                  maximum: Math.floor(Number.MAX_SAFE_INTEGER / MAX_PER_PAGE) + 1,
                  multipleOf: 1,
                }),
              ),
              per_page: t.Optional(
                t.Numeric({ minimum: 1, maximum: MAX_PER_PAGE, multipleOf: 1 }),
              ),
            }),
          },
        )
        // Upload an image. The bytes are sniffed server-side (format/dimensions),
        // hashed, deduped on sha256, then stored + persisted. 201 for a new asset,
        // 200 when an identical upload already existed.
        .post(
          "/assets",
          async ({ body, set, requestId }) => {
            const { file } = body;
            if (file.size > maxUploadBytes) {
              // Surface the attempt — a rejected upload never reaches the DB.
              logger.warn("oversize_upload_rejected", {
                requestId,
                size: file.size,
                limit: maxUploadBytes,
                mime: file.type,
              });
              throw new HttpError(413, `Upload exceeds the ${maxUploadBytes}-byte limit`);
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            const { asset, deduped } = await core.assetService.create({
              bytes,
              rating: body.rating,
              source: body.source,
            });
            set.status = deduped ? 200 : 201;
            return serializeAsset(asset);
          },
          {
            body: t.Object({
              file: t.File(),
              rating: t.Optional(ratingSchema),
              source: t.Optional(sourceSchema),
            }),
          },
        )
        // Single asset's metadata (JSON). The detail page fetches this directly
        // so deep links work without a prior list query.
        .get(
          "/assets/:id",
          async ({ params }) => {
            const asset = await core.assetService.getById(params.id);
            if (!asset) throw new HttpError(404, "Asset not found");
            return serializeAsset(asset);
          },
          { params: idParam },
        )
        // Patch an asset's mutable metadata (rating/source). Set on the post after
        // upload (Danbooru-style) or edited later from the detail page. Only the
        // provided fields change; `source: null` clears it.
        .patch(
          "/assets/:id",
          async ({ params, body }) => {
            const patch: AssetUpdate = {};
            if (body.rating !== undefined) patch.rating = body.rating;
            if (body.source !== undefined) patch.source = body.source;
            const asset = await core.assetService.update(params.id, patch);
            if (!asset) throw new HttpError(404, "Asset not found");
            return serializeAsset(asset);
          },
          {
            params: idParam,
            body: t.Object({
              rating: t.Optional(ratingSchema),
              source: t.Optional(sourceSchema),
            }),
          },
        )
        // Stream an asset's stored bytes. Kept separate from the JSON metadata so
        // the binary never has to be base64'd into a JSON payload.
        .get(
          "/assets/:id/file",
          async ({ params }) => {
            const file = await core.assetService.openFile(params.id);
            if (!file) throw new HttpError(404, "Asset not found");
            return new Response(file.stream, { headers: { "content-type": file.mimeType } });
          },
          { params: idParam },
        )
        // --- Resumable chunked uploads -------------------------------------
        // Open a session for a file; the client PATCHes chunks until complete.
        // The one-shot POST /assets above remains for small/non-browser uploads.
        .post(
          "/uploads",
          async ({ body, set }) => {
            if (body.size > maxUploadBytes) {
              throw new HttpError(413, `Upload exceeds the ${maxUploadBytes}-byte limit`);
            }
            set.status = 201;
            return core.uploadService.begin({
              filename: body.filename,
              size: body.size,
              mimeType: body.mimeType ?? null,
            });
          },
          {
            body: t.Object({
              filename: t.String({ maxLength: 1024 }),
              size: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              mimeType: t.Optional(t.String({ maxLength: 255 })),
            }),
          },
        )
        // Report the committed offset so a client can resume after an interruption.
        .head(
          "/uploads/:token",
          async ({ params, set }) => {
            const info = await core.uploadService.offsetOf(params.token);
            if (!info) throw new HttpError(404, "Upload session not found");
            set.headers["upload-offset"] = String(info.offset);
            set.headers["upload-length"] = String(info.size);
            set.status = 200;
            return "";
          },
          { params: tokenParam },
        )
        // Append a raw binary chunk at `Upload-Offset`: 204 + new offset while
        // incomplete; 201 (or 200 deduped) with the asset once the file finalizes.
        .patch(
          "/uploads/:token",
          async ({ params, body, request, set }) => {
            const header = request.headers.get("upload-offset");
            const offset = Number(header);
            if (header === null || !Number.isSafeInteger(offset) || offset < 0) {
              throw new HttpError(400, "Missing or invalid Upload-Offset header");
            }
            // Require a raw-bytes content-type so a JSON/form/text body can't be
            // appended verbatim into the staged file.
            const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
            if (
              contentType !== "application/octet-stream" &&
              contentType !== "application/offset+octet-stream"
            ) {
              throw new HttpError(415, "Chunk body must be sent as raw bytes (application/octet-stream)");
            }
            // Elysia hands an octet-stream body back as ArrayBuffer/Uint8Array;
            // fall back to the raw request stream if it wasn't pre-parsed.
            const chunk =
              body instanceof Uint8Array
                ? body
                : body instanceof ArrayBuffer
                  ? new Uint8Array(body)
                  : new Uint8Array(await request.arrayBuffer());
            const result = await core.uploadService.appendChunk(params.token, offset, chunk);
            if (result.status === "incomplete") {
              set.headers["upload-offset"] = String(result.offset);
              set.status = 204;
              return "";
            }
            set.status = result.deduped ? 200 : 201;
            return serializeAsset(result.asset);
          },
          { params: tokenParam },
        )
        // Cancel a session and delete its staged bytes.
        .delete(
          "/uploads/:token",
          async ({ params, set }) => {
            await core.uploadService.cancel(params.token);
            set.status = 204;
            return "";
          },
          { params: tokenParam },
        ),
    );
}

/** Server type for end-to-end type safety with the Eden Treaty client. */
export type App = ReturnType<typeof createApp>;
