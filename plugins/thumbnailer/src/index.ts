import { fileURLToPath } from "node:url";

import { eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  definePlugin,
  pluginRoutePrefix,
  type PluginContext,
} from "@bunbooru/plugin-sdk";

import { thumbnails } from "./schema";
import { makeThumbnail } from "./thumbnail";

/** This plugin's stable id — route-prefix segment + migrations-table suffix. */
const PLUGIN_ID = "thumbnailer";

/** Longest side of a generated thumbnail (px). Source is never upscaled. */
const THUMB_MAX = 300;

/** How many assets one `POST /backfill` attempts (bounds work per request). */
const BACKFILL_BATCH = 200;

/** Max thumbnails generated concurrently from the event stream (bounds CPU/mem
 *  under a bulk import that emits many `asset.created` events at once). */
const EVENT_CONCURRENCY = 2;

/** Read a stored asset's full bytes for (re-)thumbnailing. */
async function readAssetBytes(ctx: PluginContext, assetId: number): Promise<Uint8Array | null> {
  const file = await ctx.services.assets.openFile(assetId);
  if (!file) return null; // asset row gone, or its blob is missing
  return new Response(file.stream).bytes();
}

/** Record a successful thumbnail (idempotent upsert by `assetId`, clears any prior failure). */
async function recordSuccess(
  ctx: PluginContext,
  assetId: number,
  storageKey: string,
  width: number,
  height: number,
): Promise<void> {
  await ctx.db
    .insert(thumbnails)
    .values({ assetId, storageKey, width, height, failedAt: null })
    .onConflictDoUpdate({
      target: thumbnails.assetId,
      set: { storageKey, width, height, failedAt: null },
    });
}

/**
 * Record a generation failure so it isn't retried on every backfill. Never
 * overwrites an existing SUCCESS row (`setWhere` guards it) — a later blob
 * deletion shouldn't demote a good thumbnail's bookkeeping.
 */
async function recordFailure(ctx: PluginContext, assetId: number): Promise<void> {
  const now = new Date();
  await ctx.db
    .insert(thumbnails)
    .values({ assetId, storageKey: null, width: null, height: null, failedAt: now })
    .onConflictDoUpdate({
      target: thumbnails.assetId,
      set: { failedAt: now },
      setWhere: isNull(thumbnails.storageKey),
    });
}

/** The outcome of attempting one asset. */
type Outcome = "generated" | "failed";

/**
 * Generate + store a thumbnail for one asset and record the outcome. Records a
 * failure row (rather than throwing) when the asset/blob is gone or the bytes
 * can't be decoded, so callers never throw and the backfill can terminate.
 */
async function processAsset(ctx: PluginContext, assetId: number): Promise<Outcome> {
  const bytes = await readAssetBytes(ctx, assetId);
  let thumb: Awaited<ReturnType<typeof makeThumbnail>> | undefined;
  if (bytes) {
    try {
      thumb = await makeThumbnail(bytes, THUMB_MAX);
    } catch (error) {
      ctx.log.warn("thumbnail_generate_failed", {
        assetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!thumb) {
    await recordFailure(ctx, assetId);
    return "failed";
  }
  const storageKey = `${assetId}.webp`;
  await ctx.storage.store(storageKey, thumb.bytes);
  await recordSuccess(ctx, assetId, storageKey, thumb.width, thumb.height);
  return "generated";
}

/** Whether an asset already has a thumbnails row (success OR recorded failure). */
async function hasRecord(ctx: PluginContext, assetId: number): Promise<boolean> {
  const rows = await ctx.db
    .select({ assetId: thumbnails.assetId })
    .from(thumbnails)
    .where(eq(thumbnails.assetId, assetId))
    .limit(1);
  return rows.length > 0;
}

/** Counts for the admin status: successes, recorded failures, total attempts. */
async function counts(ctx: PluginContext): Promise<{ succeeded: number; failed: number; attempted: number }> {
  const rows = await ctx.db
    .select({
      succeeded: sql<number>`count(*) filter (where ${isNotNull(thumbnails.storageKey)})::int`,
      failed: sql<number>`count(*) filter (where ${isNull(thumbnails.storageKey)})::int`,
      attempted: sql<number>`count(*)::int`,
    })
    .from(thumbnails);
  return rows[0] ?? { succeeded: 0, failed: 0, attempted: 0 };
}

/**
 * Attempt thumbnails for assets that have no record yet, up to {@link
 * BACKFILL_BATCH} attempts per call. Pages through the asset list (via the Core
 * service — no direct Core-table access). The batch counts BOTH successes and
 * failures, and `remaining` counts only never-attempted assets, so a permanently
 * failing asset gets a row and the caller's loop terminates.
 */
async function backfill(
  ctx: PluginContext,
): Promise<{ scanned: number; generated: number; failed: number; remaining: number }> {
  let scanned = 0;
  let generated = 0;
  let failed = 0;
  let page = 1;
  const perPage = 100;

  outer: for (;;) {
    const result = await ctx.services.assets.list({ page, perPage });
    if (result.assets.length === 0) break;
    for (const asset of result.assets) {
      scanned += 1;
      if (await hasRecord(ctx, asset.id)) continue;
      const outcome = await processAsset(ctx, asset.id);
      if (outcome === "generated") generated += 1;
      else failed += 1;
      // Count attempts (not just successes) toward the cap so a page of failures
      // can't make one request scan the entire asset list.
      if (generated + failed >= BACKFILL_BATCH) break outer;
    }
    if (page >= result.pageCount) break;
    page += 1;
  }

  // "remaining" = never-attempted assets (total − attempted). Failures have rows,
  // so they're excluded — the UI stops re-invoking instead of looping forever.
  const total = (await ctx.services.stats.getStats()).posts;
  const remaining = Math.max(0, total - (await counts(ctx)).attempted);
  return { scanned, generated, failed, remaining };
}

/**
 * A fixed-concurrency worker over asset ids, so the `asset.created` fan-out
 * during a bulk import decodes at most {@link EVENT_CONCURRENCY} images at once
 * instead of one per event. Deduplicates ids already queued.
 */
function createBoundedQueue(concurrency: number, worker: (id: number) => Promise<void>) {
  const queued = new Set<number>();
  const pending: number[] = [];
  let active = 0;
  const pump = (): void => {
    while (active < concurrency && pending.length > 0) {
      const id = pending.shift() as number;
      queued.delete(id);
      active += 1;
      worker(id).finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  return (id: number): void => {
    if (queued.has(id)) return;
    queued.add(id);
    pending.push(id);
    pump();
  };
}

/**
 * Build the thumbnailer's HTTP routes. Extracted so its return TYPE can drive a
 * typed Eden client on the web ({@link ThumbnailerPluginApp}). Prefixed with
 * {@link pluginRoutePrefix} so paths resolve under `/api/v1/plugins/thumbnailer`.
 */
export function buildThumbnailerRoutes(ctx: PluginContext) {
  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    // Serve an asset's thumbnail (public). 404 when there's no SUCCESSFUL thumbnail
    // (missing, failed, or bytes gone) so the web falls back to the full image.
    .get(
      "/asset/:id/thumb",
      async ({ params, set }) => {
        const rows = await ctx.db
          .select({ storageKey: thumbnails.storageKey })
          .from(thumbnails)
          .where(eq(thumbnails.assetId, params.id))
          .limit(1);
        const storageKey = rows[0]?.storageKey;
        if (!storageKey || !(await ctx.storage.exists(storageKey))) {
          set.status = 404;
          return "";
        }
        return new Response(await ctx.storage.stream(storageKey), {
          headers: {
            "content-type": "image/webp",
            "cache-control": "public, max-age=86400",
          },
        });
      },
      { params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }) },
    )
    // Success/failure/missing counts (admin-only).
    .get("/status", async ({ request }) => {
      await requireAdmin(ctx, request);
      const totalAssets = (await ctx.services.stats.getStats()).posts;
      const { succeeded, failed, attempted } = await counts(ctx);
      return {
        totalAssets,
        withThumbnails: succeeded,
        failed,
        missing: Math.max(0, totalAssets - attempted),
      };
    })
    // Attempt a bounded batch of missing thumbnails (admin-only). Re-invoke while
    // `remaining` is non-zero.
    .post("/backfill", async ({ request }) => {
      await requireAdmin(ctx, request);
      return backfill(ctx);
    });
}

/** Assert the caller is an admin (401 anonymous / 403 non-admin). */
async function requireAdmin(ctx: PluginContext, request: Request): Promise<void> {
  const user = await ctx.auth.currentUser(request);
  if (!user) throw new AuthenticationError();
  if (!canModerate(user)) throw new AuthorizationError();
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type ThumbnailerPluginApp = ReturnType<typeof buildThumbnailerRoutes>;

/**
 * Thumbnailer plugin — generates a webp thumbnail for every asset via Bun's native
 * image API. Subscribes to `asset.created` (the Event-Rule flow `AssetCreated →
 * Thumbnail`) to thumbnail new/imported uploads automatically (through a bounded
 * work queue), serves them, and offers an admin backfill for pre-existing assets.
 * Second reference plugin; the first to use `ctx.storage` and the event bus.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Thumbnailer",
  version: "0.1.0",
  migrations: {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsTable: "__drizzle_migrations_thumbnailer",
  },
  register(ctx) {
    // Bounded worker: a burst of `asset.created` events (e.g. a bulk import) is
    // drained at a fixed concurrency, not one full-image decode per event.
    const enqueue = createBoundedQueue(EVENT_CONCURRENCY, async (assetId) => {
      try {
        await processAsset(ctx, assetId);
      } catch (error) {
        // processAsset records failures itself; this catches unexpected faults
        // (e.g. storage/db down) so the worker loop never dies.
        ctx.log.error("thumbnail_worker_failed", {
          assetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    ctx.events.on("asset.created", (event) => enqueue(event.id));

    return {
      routes: buildThumbnailerRoutes(ctx),
      adminPages: [{ id: "thumbnails", title: "Thumbnails" }],
    };
  },
});
