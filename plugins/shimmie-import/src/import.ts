import { and, eq, ne, sql } from "drizzle-orm";

import type { PluginContext } from "@bunbooru/plugin-sdk";

import { importItems, importRuns } from "./schema";
import type { SourceAdapter, SourcePost } from "./source-adapter";

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
  runId: number,
  // Discriminated union: a `complete` row always carries the asset it produced,
  // a `failed` row never does — so the ledger can't record a success with no
  // asset (or a failure that still points at one).
  fields:
    | { assetId: number; status: "complete"; error: null }
    | { assetId: null; status: "failed"; error: string },
): Promise<void> {
  await ctx.db
    .insert(importItems)
    .values({ sourceInstance, sourcePostId, runId, ...fields })
    .onConflictDoUpdate({
      target: [importItems.sourceInstance, importItems.sourcePostId],
      // Record the run that last touched it (scopes retry-failed).
      set: { ...fields, runId, updatedAt: new Date() },
      // `complete` is terminal: never let a later (e.g. concurrent) `failed`
      // overwrite a successful import and clear its assetId.
      setWhere: ne(importItems.status, "complete"),
    });
}

/**
 * Ingest one already-fetched post: download bytes → `create` (preserving
 * rating/source/date, attributing to the target user) → `setAssetTags` → record
 * the outcome in the ledger. Never throws — a failure records a `failed` row and
 * returns "failed". Shared by {@link stepRun} and {@link retryFailed}.
 */
async function ingestPost(
  ctx: PluginContext,
  adapter: SourceAdapter,
  post: SourcePost,
  runId: number,
  targetUserId: number,
): Promise<"complete" | "failed"> {
  // Track the asset once created so a LATER failure (e.g. setAssetTags) is logged
  // WITH the asset id — the created asset isn't lost even though the ledger's
  // `failed` row can't carry an assetId. A retry re-runs (sha256 dedupe returns
  // the same asset) and re-applies the tags, recovering it.
  let createdAssetId: number | undefined;
  try {
    const bytes = await adapter.fetchBytes(post);
    const { asset } = await ctx.services.assets.create({
      bytes,
      rating: post.rating,
      source: post.postUrl,
      uploaderId: targetUserId,
      createdAt: post.postedAt,
    });
    createdAssetId = asset.id;
    if (post.tags.length > 0) await ctx.services.tags.setAssetTags(asset.id, post.tags);
    await upsertItem(ctx, adapter.sourceInstance, post.sourcePostId, runId, {
      assetId: asset.id,
      status: "complete",
      error: null,
    });
    return "complete";
  } catch (error) {
    await upsertItem(ctx, adapter.sourceInstance, post.sourcePostId, runId, {
      assetId: null,
      status: "failed",
      error: errorMessage(error),
    });
    ctx.log.warn("import_post_failed", {
      sourcePostId: post.sourcePostId,
      createdAssetId,
      error: errorMessage(error),
    });
    return "failed";
  }
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

    let post: Awaited<ReturnType<SourceAdapter["fetchPost"]>>;
    try {
      post = await adapter.fetchPost(sourcePostId);
    } catch (error) {
      // A fetch/GraphQL error (not a deletion) is recorded + retryable on a new run.
      await upsertItem(ctx, adapter.sourceInstance, sourcePostId, run.id, {
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

    if ((await ingestPost(ctx, adapter, post, run.id, run.targetUserId)) === "complete") {
      imported += 1;
    } else {
      failed += 1;
    }
  }

  const done = cursor >= run.maxId;
  const totals = {
    imported: run.imported + imported,
    failed: run.failed + failed,
    skipped: run.skipped + skipped,
  };
  // Optimistic concurrency: only commit the new absolute totals if no other
  // step advanced the cursor since we read it (WHERE cursor = the value we read)
  // AND the run is still `running`. The status guard matters because a step is
  // long (network-bound) and `cancel` can land mid-flight: without it, this
  // write would resurrect a canceled run back to `running`/`done`.
  // If either guard fails, we drop this counter write — our per-post ledger rows
  // still stand, and Core's sha256 dedupe prevents duplicate assets.
  const committed = await ctx.db
    .update(importRuns)
    .set({
      cursor,
      imported: totals.imported,
      failed: totals.failed,
      skipped: totals.skipped,
      status: done ? "done" : "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importRuns.id, runId),
        eq(importRuns.cursor, run.cursor),
        eq(importRuns.status, "running"),
      ),
    )
    .returning({ id: importRuns.id });

  if (committed.length === 0) {
    // Our write lost (cancel, or a concurrent step). The per-step counts below
    // are still true — that work really happened — but cursor/done/totals must
    // report the PERSISTED run, not our dropped local view, or the client would
    // act on a state the database never accepted.
    const currentRows = await ctx.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, runId))
      .limit(1);
    const current = currentRows[0];
    if (current) {
      return {
        imported,
        failed,
        skipped,
        cursor: current.cursor,
        maxId: current.maxId,
        done: current.status !== "running",
        totals: {
          imported: current.imported,
          failed: current.failed,
          skipped: current.skipped,
        },
      };
    }
  }

  return { imported, failed, skipped, cursor, maxId: run.maxId, done, totals };
}

/** Failed posts re-attempted per `retry-failed` call. */
const RETRY_BATCH = 25;

/** Outcome of one {@link retryFailed} call. */
export interface RetryResult {
  /** Failed items attempted this call. */
  retried: number;
  /** Now imported. */
  recovered: number;
  /** Still failing after the retry. */
  stillFailed: number;
  /** Failed items remaining for THIS run after this call. */
  remainingFailed: number;
}

/** Count the `failed` ledger rows owned by a run. */
async function countFailed(ctx: PluginContext, runId: number): Promise<number> {
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(importItems)
    .where(and(eq(importItems.runId, runId), eq(importItems.status, "failed")));
  return rows[0]?.n ?? 0;
}

/**
 * Re-attempt up to {@link RETRY_BATCH} previously-`failed` posts of ONE run
 * (e.g. after a transient network blip), without re-scanning the whole id space.
 * Scoped by `runId` (not the whole source) so it can't re-attribute another run's
 * posts to this run's target user. A source post that has since been deleted has
 * its stale `failed` row removed. Recovered items move from the run's `failed`
 * counter to `imported`. The client loops until this run's failures reach 0 OR a
 * batch recovers nothing (permanent failures).
 */
export async function retryFailed(
  ctx: PluginContext,
  adapter: SourceAdapter,
  runId: number,
): Promise<RetryResult> {
  const runRows = await ctx.db.select().from(importRuns).where(eq(importRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) throw new Error("Import run not found");
  // A canceled run is terminal — don't resurrect it by retrying/updating counters.
  if (run.status === "canceled") throw new Error("Cannot retry a canceled import run");

  const failedRows = await ctx.db
    .select({ sourcePostId: importItems.sourcePostId })
    .from(importItems)
    .where(and(eq(importItems.runId, runId), eq(importItems.status, "failed")))
    .orderBy(importItems.sourcePostId)
    .limit(RETRY_BATCH);

  let recovered = 0;
  let stillFailed = 0;
  let deleted = 0;

  for (const { sourcePostId } of failedRows) {
    let post;
    try {
      post = await adapter.fetchPost(sourcePostId);
    } catch (error) {
      await upsertItem(ctx, adapter.sourceInstance, sourcePostId, runId, {
        assetId: null,
        status: "failed",
        error: errorMessage(error),
      });
      stillFailed += 1;
      continue;
    }
    if (!post) {
      // Source post is gone now — drop the stale failed row (nothing to recover).
      await ctx.db
        .delete(importItems)
        .where(
          and(eq(importItems.sourceInstance, adapter.sourceInstance), eq(importItems.sourcePostId, sourcePostId)),
        );
      deleted += 1;
      continue;
    }
    if ((await ingestPost(ctx, adapter, post, runId, run.targetUserId)) === "complete") recovered += 1;
    else stillFailed += 1;
  }

  // A recovered failure becomes an import; a deleted stale failure just disappears.
  // Both reduce the run's `failed` count. Relative SQL increments (not absolute
  // values from the stale snapshot) so a concurrent step's write isn't clobbered,
  // and the status guard keeps a concurrently-canceled run terminal.
  if (recovered > 0 || deleted > 0) {
    await ctx.db
      .update(importRuns)
      .set({
        imported: sql`${importRuns.imported} + ${recovered}`,
        failed: sql`greatest(${importRuns.failed} - ${recovered + deleted}, 0)`,
        updatedAt: new Date(),
      })
      .where(and(eq(importRuns.id, runId), ne(importRuns.status, "canceled")));
  }

  return {
    retried: failedRows.length,
    recovered,
    stillFailed,
    remainingFailed: await countFailed(ctx, runId),
  };
}
