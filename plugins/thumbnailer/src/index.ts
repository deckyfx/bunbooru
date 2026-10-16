import { embeddedMigrations } from "./migrations.embedded";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  definePlugin,
  pluginRoutePrefix,
  type JsonValue,
  type PluginContext,
} from "@bunbooru/plugin-sdk";

import { thumbnails } from "./schema";
import { makeThumbnail } from "./thumbnail";
import { walkPages } from "./walk-pages";

/** This plugin's stable id — route-prefix segment + migrations-table suffix. */
const PLUGIN_ID = "thumbnailer";

/** Longest side of a generated thumbnail (px). Source is never upscaled. */
const THUMB_MAX = 300;

/** Asset pages (of {@link BACKFILL_PAGE_SIZE}) one backfill job scans before
 *  handing the rest to the next job in its chain. */
const BACKFILL_PAGES_PER_JOB = 10;
const BACKFILL_PAGE_SIZE = 100;

/** The idempotency key of a thumbnail job for `assetId`: one pending job per asset. */
const thumbKey = (assetId: number): string => `thumb:${assetId}`;

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

/**
 * Generate + store a thumbnail for one asset and record the outcome. Records a
 * failure row (rather than throwing) when the asset/blob is gone or the bytes
 * can't be decoded: retrying those can't help, and the row stops the backfill
 * from queueing the asset again. Storage and database faults DO throw, so the
 * job retries them.
 */
async function processAsset(ctx: PluginContext, assetId: number): Promise<void> {
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
    return;
  }
  const storageKey = `${assetId}.webp`;
  await ctx.storage.store(storageKey, thumb.bytes);
  await recordSuccess(ctx, assetId, storageKey, thumb.width, thumb.height);
}

/**
 * Which of `assetIds` already have a thumbnails row (success OR recorded failure).
 * One batched query per page — not one per asset — so a full backfill stays ~O(N)
 * instead of O(N²/batch) as already-recorded assets get re-scanned each call.
 */
async function recordedIds(ctx: PluginContext, assetIds: number[]): Promise<Set<number>> {
  if (assetIds.length === 0) return new Set();
  const rows = await ctx.db
    .select({ assetId: thumbnails.assetId })
    .from(thumbnails)
    .where(inArray(thumbnails.assetId, assetIds));
  return new Set(rows.map((row) => row.assetId));
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

/** Whether `assetId` already has a SUCCESSFUL thumbnail. */
async function hasThumbnail(ctx: PluginContext, assetId: number): Promise<boolean> {
  const rows = await ctx.db
    .select({ assetId: thumbnails.assetId })
    .from(thumbnails)
    .where(and(eq(thumbnails.assetId, assetId), isNotNull(thumbnails.storageKey)))
    .limit(1);
  return rows.length > 0;
}

/** The `{ [field]: … }` object a job payload is expected to be, or throw. */
function payloadObject(payload: JsonValue): { [key: string]: JsonValue } {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) return payload;
  throw new Error(`malformed job payload: ${JSON.stringify(payload)}`);
}

/** The asset id of a `thumbnail` job's payload, or throw. */
function assetIdOf(payload: JsonValue): number {
  const { assetId } = payloadObject(payload);
  if (typeof assetId === "number" && Number.isSafeInteger(assetId) && assetId > 0) return assetId;
  throw new Error(`malformed thumbnail payload: ${JSON.stringify(payload)}`);
}

/** The resume cursor of a `backfill` job's payload (null = from the start), or throw. */
function cursorOf(payload: JsonValue): string | null {
  const { cursor } = payloadObject(payload);
  if (cursor === null || typeof cursor === "string") return cursor;
  throw new Error(`malformed backfill payload: ${JSON.stringify(payload)}`);
}

/**
 * One link of a backfill chain: scan up to {@link BACKFILL_PAGES_PER_JOB} pages
 * of assets from `cursor`, queue a thumbnail job for each that has no record
 * yet (success or recorded failure), then queue the next link for the rest.
 * Walks by cursor through the Core service (no direct Core-table access), so
 * every link costs the same however far into a large library it is.
 */
async function backfillFrom(ctx: PluginContext, cursor: string | null): Promise<void> {
  let pages = 0;
  let queued = 0;
  const resume = await walkPages(
    (at) => ctx.services.assets.list({ perPage: BACKFILL_PAGE_SIZE, cursor: at }),
    async (assets) => {
      // One batched lookup per page, not one per asset.
      const alreadyRecorded = await recordedIds(ctx, assets.map((asset) => asset.id));
      for (const asset of assets) {
        if (alreadyRecorded.has(asset.id)) continue;
        const job = await ctx.jobs.enqueue("thumbnail", { assetId: asset.id }, { idempotencyKey: thumbKey(asset.id) });
        if (job.created) queued += 1;
      }
      pages += 1;
      return pages >= BACKFILL_PAGES_PER_JOB ? "stop" : "continue";
    },
    cursor ?? undefined,
  );
  ctx.log.info("thumbnail_backfill_link", { queued, more: resume !== null });
  // Keyed by its cursor, so a link re-run after a crash doesn't fork the chain.
  if (resume !== null) {
    await ctx.jobs.enqueue("backfill", { cursor: resume }, { idempotencyKey: `backfill:${resume}` });
  }
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
    // Queue thumbnails for every asset without one (admin-only). The work runs
    // in the background as a chain of jobs; `queued: false` means a backfill
    // is already starting.
    .post("/backfill", async ({ request }) => {
      await requireAdmin(ctx, request);
      const job = await ctx.jobs.enqueue("backfill", { cursor: null }, { idempotencyKey: "backfill" });
      return { queued: job.created };
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
 * Thumbnail`) and queues a durable `thumbnail` job per new or imported upload,
 * so the work survives restarts, retries, and runs at the job runner's bounded
 * concurrency. Serves the thumbnails, and offers an admin backfill (a chain of
 * `backfill` jobs) for pre-existing assets.
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Thumbnailer",
  version: "0.1.0",
  description: "Generates WebP thumbnails for uploaded images on the asset.created event.",
  capabilities: ["routes", "tables", "events", "jobs", "ui-slots"],
  tables: ["thumbnails"],
  migrations: {
    // Migrations embedded into the binary (regenerate: `bun run gen:migrations`).
    embedded: embeddedMigrations,
    migrationsTable: "__drizzle_migrations_thumbnailer",
  },
  register(ctx) {
    ctx.events.on("asset.created", async (event) => {
      try {
        await ctx.jobs.enqueue("thumbnail", { assetId: event.id }, { idempotencyKey: thumbKey(event.id) });
      } catch (error) {
        // The database is down; the admin backfill picks the asset up later.
        ctx.log.error("thumbnail_enqueue_failed", {
          assetId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return {
      routes: buildThumbnailerRoutes(ctx),
      jobs: {
        thumbnail: {
          // A missing blob or an undecodable image is recorded as a failure
          // (not thrown), so retries only cover storage and database faults.
          maxAttempts: 3,
          timeoutMs: 5 * 60 * 1000,
          async run(payload) {
            const assetId = assetIdOf(payload);
            // Already done (a duplicate backfill chain, or a re-run).
            if (await hasThumbnail(ctx, assetId)) return;
            await processAsset(ctx, assetId);
          },
        },
        backfill: {
          maxAttempts: 3,
          async run(payload) {
            await backfillFrom(ctx, cursorOf(payload));
          },
        },
      },
    };
  },
});
