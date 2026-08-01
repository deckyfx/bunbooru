import { and, eq, ne } from "drizzle-orm";

import type { PluginContext } from "@bunbooru/plugin-sdk";

import { importItems, importRuns } from "./schema";
import type { SourceAdapter } from "./source-adapter";

/** Posts ATTEMPTED (imported + failed) per `step` call. */
const IMPORT_BATCH = 25;

/**
 * Hard cap on ids SCANNED per `step`, independent of imports/failures. Without
 * it, a run over a large id space where most ids are deleted or filtered out
 * would scan (and `fetchPost`) up to `maxId` in a single request. The client just
 * calls `step` again to continue.
 */
const MAX_SCAN_PER_STEP = IMPORT_BATCH * 20;

/** Progress from one `step` call plus the run's running totals. */
export interface StepResult {
  imported: number;
  failed: number;
  skipped: number;
  cursor: number;
  maxId: number;
  done: boolean;
  totals: { imported: number; failed: number; skipped: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build an owner-name predicate from the stored user filter (`*` = all). */
function makeMatcher(userFilter: string): (owner: string) => boolean {
  if (userFilter === "*") return () => true;
  const names = new Set(
    userFilter
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return (owner) => names.has(owner.toLowerCase());
}

/** Upsert a ledger row for a processed source post (idempotency + provenance). */
async function upsertItem(
  ctx: PluginContext,
  sourceInstance: string,
  sourcePostId: number,
  fields: { assetId: number | null; status: "complete" | "failed"; error: string | null },
): Promise<void> {
  await ctx.db
    .insert(importItems)
    .values({ sourceInstance, sourcePostId, ...fields })
    .onConflictDoUpdate({
      target: [importItems.sourceInstance, importItems.sourcePostId],
      set: { ...fields, updatedAt: new Date() },
      // `complete` is terminal: never let a later (e.g. concurrent) `failed`
      // overwrite a successful import and clear its assetId.
      setWhere: ne(importItems.status, "complete"),
    });
}

/** Whether this source post was already imported successfully (skip on re-run). */
async function alreadyComplete(
  ctx: PluginContext,
  sourceInstance: string,
  sourcePostId: number,
): Promise<boolean> {
  const rows = await ctx.db
    .select({ status: importItems.status })
    .from(importItems)
    .where(and(eq(importItems.sourceInstance, sourceInstance), eq(importItems.sourcePostId, sourcePostId)))
    .limit(1);
  return rows[0]?.status === "complete";
}

/**
 * Process one bounded batch of a run, resuming from its cursor. For each source
 * id in turn: fetch the post (null → deleted, skip), apply the user filter, skip
 * if already complete, else download bytes → `createFromSource` (preserving
 * rating/source/date, attributing to the target user) → `setAssetTags`, and
 * record the outcome in the ledger. A per-post error is recorded + counted, never
 * thrown, so the batch (and the run) make progress. Idempotent: Core's sha256
 * dedupe + the ledger mean a re-run never duplicates.
 */
export async function stepRun(
  ctx: PluginContext,
  adapter: SourceAdapter,
  runId: number,
): Promise<StepResult> {
  const runRows = await ctx.db.select().from(importRuns).where(eq(importRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) throw new Error("Import run not found");

  if (run.status !== "running") {
    return {
      imported: 0,
      failed: 0,
      skipped: 0,
      cursor: run.cursor,
      maxId: run.maxId,
      done: run.status === "done",
      totals: { imported: run.imported, failed: run.failed, skipped: run.skipped },
    };
  }

  const matches = makeMatcher(run.userFilter);
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let scanned = 0;
  let cursor = run.cursor;

  while (imported + failed < IMPORT_BATCH && scanned < MAX_SCAN_PER_STEP && cursor < run.maxId) {
    cursor += 1;
    scanned += 1;
    const sourcePostId = cursor;

    let post;
    try {
      post = await adapter.fetchPost(sourcePostId);
    } catch (error) {
      // A fetch/GraphQL error (not a deletion) is recorded + retryable on a new run.
      await upsertItem(ctx, adapter.sourceInstance, sourcePostId, {
        assetId: null,
        status: "failed",
        error: errorMessage(error),
      });
      failed += 1;
      ctx.log.warn("import_fetch_failed", { sourcePostId, error: errorMessage(error) });
      continue;
    }
    if (!post) {
      skipped += 1; // deleted / non-existent id
      continue;
    }
    if (!matches(post.owner)) {
      skipped += 1; // different owner than the filter
      continue;
    }
    if (await alreadyComplete(ctx, adapter.sourceInstance, sourcePostId)) {
      skipped += 1;
      continue;
    }

    try {
      const bytes = await adapter.fetchBytes(post);
      const { asset } = await ctx.services.assets.create({
        bytes,
        rating: post.rating,
        source: post.postUrl,
        uploaderId: run.targetUserId,
        createdAt: post.postedAt,
      });
      if (post.tags.length > 0) await ctx.services.tags.setAssetTags(asset.id, post.tags);
      await upsertItem(ctx, adapter.sourceInstance, sourcePostId, {
        assetId: asset.id,
        status: "complete",
        error: null,
      });
      imported += 1;
    } catch (error) {
      await upsertItem(ctx, adapter.sourceInstance, sourcePostId, {
        assetId: null,
        status: "failed",
        error: errorMessage(error),
      });
      failed += 1;
      ctx.log.warn("import_post_failed", { sourcePostId, error: errorMessage(error) });
    }
  }

  const done = cursor >= run.maxId;
  const totals = {
    imported: run.imported + imported,
    failed: run.failed + failed,
    skipped: run.skipped + skipped,
  };
  // Optimistic concurrency: only commit the new absolute totals if no other
  // step advanced the cursor since we read it (WHERE cursor = the value we read).
  // If a concurrent step won, we drop this counter write — our per-post ledger
  // rows still stand, and Core's sha256 dedupe prevents duplicate assets.
  await ctx.db
    .update(importRuns)
    .set({
      cursor,
      imported: totals.imported,
      failed: totals.failed,
      skipped: totals.skipped,
      status: done ? "done" : "running",
      updatedAt: new Date(),
    })
    .where(and(eq(importRuns.id, runId), eq(importRuns.cursor, run.cursor)));

  return { imported, failed, skipped, cursor, maxId: run.maxId, done, totals };
}
