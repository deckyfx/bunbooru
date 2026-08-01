import { fileURLToPath } from "node:url";

import { desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  definePlugin,
  pluginRoutePrefix,
  type PluginContext,
  type User,
} from "@bunbooru/plugin-sdk";

import { stepRun } from "./import";
import { importRuns } from "./schema";
import { ShimmieAdapter } from "./shimmie-adapter";

/** This plugin's stable id — route-prefix segment + migrations-table suffix. */
const PLUGIN_ID = "shimmie-import";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `tz` is a timezone the runtime accepts (so a bad value fails the run
 *  up front, not silently on every post during stepping). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Build a shimmie adapter, surfacing a bad base URL as a domain error. */
function makeAdapter(baseUrl: string, apiKey: string, timezone?: string): ShimmieAdapter {
  try {
    return new ShimmieAdapter({ baseUrl, apiKey, timezone });
  } catch {
    throw new Error("Invalid shimmie base URL");
  }
}

/** Body schema for the credential-bearing endpoints. */
const sourceBody = t.Object({
  baseUrl: t.String({ minLength: 1, maxLength: 2048 }),
  apiKey: t.String({ minLength: 1, maxLength: 500 }),
});

/**
 * Build the importer's admin routes. All are admin-only. Config/adapter failures
 * (bad URL, disabled extension, invalid key) return `{ ok: false, error }` rather
 * than throwing, so the web can show the operator exactly what to fix.
 */
export function buildImportRoutes(ctx: PluginContext) {
  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    // Validate connectivity + auth against the source; report the acting user +
    // max post id. This is the preflight the operator runs before importing.
    .post(
      "/preflight",
      async ({ body, request }) => {
        await requireAdmin(ctx, request);
        try {
          const result = await makeAdapter(body.baseUrl, body.apiKey).preflight();
          return { ok: true as const, ...result };
        } catch (error) {
          return { ok: false as const, error: errorMessage(error) };
        }
      },
      { body: sourceBody },
    )
    // Start a run: preflight (for maxId), then create the run record. The api_key
    // is NOT stored — the client re-sends it on each `step`.
    .post(
      "/runs",
      async ({ body, request }) => {
        const admin = await requireAdmin(ctx, request);
        try {
          const timezone = body.sourceTimezone?.trim() || "UTC";
          if (!isValidTimeZone(timezone)) {
            return { ok: false as const, error: `Unknown timezone "${timezone}" (use an IANA name like "UTC" or "Asia/Jakarta")` };
          }
          const adapter = makeAdapter(body.baseUrl, body.apiKey, timezone);
          const { maxId } = await adapter.preflight();
          const userFilter = body.users === "*" ? "*" : body.users.join(",");
          const targetUserId = body.targetUserId ?? admin.id;
          const inserted = await ctx.db
            .insert(importRuns)
            .values({ sourceInstance: adapter.sourceInstance, userFilter, sourceTimezone: timezone, targetUserId, maxId })
            .returning({ id: importRuns.id });
          const runId = inserted[0]?.id;
          if (runId === undefined) throw new Error("Failed to create the import run");
          return { ok: true as const, runId, maxId };
        } catch (error) {
          return { ok: false as const, error: errorMessage(error) };
        }
      },
      {
        body: t.Object({
          baseUrl: t.String({ minLength: 1, maxLength: 2048 }),
          apiKey: t.String({ minLength: 1, maxLength: 500 }),
          // `*` = all users, else an explicit list of shimmie usernames.
          users: t.Union([
            t.Literal("*"),
            // At least one username (an empty list would match nobody and import zero).
            t.Array(t.String({ maxLength: 100 }), { minItems: 1, maxItems: 100 }),
          ]),
          // Target bunbooru user id to attribute posts to; defaults to the admin.
          targetUserId: t.Optional(t.Integer({ minimum: 1 })),
          // IANA timezone of the source's naive timestamps (default UTC).
          sourceTimezone: t.Optional(t.String({ maxLength: 64 })),
        }),
      },
    )
    // Process one bounded batch of a run. The client loops this until `done`.
    .post(
      "/runs/:id/step",
      async ({ params, body, request }) => {
        await requireAdmin(ctx, request);
        try {
          const runRows = await ctx.db
            .select({
              sourceInstance: importRuns.sourceInstance,
              sourceTimezone: importRuns.sourceTimezone,
            })
            .from(importRuns)
            .where(eq(importRuns.id, params.id))
            .limit(1);
          const run = runRows[0];
          if (!run) return { ok: false as const, error: "Import run not found" };
          const adapter = makeAdapter(run.sourceInstance, body.apiKey, run.sourceTimezone);
          const result = await stepRun(ctx, adapter, params.id);
          return { ok: true as const, ...result };
        } catch (error) {
          return { ok: false as const, error: errorMessage(error) };
        }
      },
      {
        params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
        body: t.Object({ apiKey: t.String({ minLength: 1, maxLength: 500 }) }),
      },
    )
    // A run's progress (admin-only).
    .get(
      "/runs/:id",
      async ({ params, request }) => {
        await requireAdmin(ctx, request);
        const rows = await ctx.db.select().from(importRuns).where(eq(importRuns.id, params.id)).limit(1);
        const run = rows[0];
        if (!run) return { ok: false as const, error: "Import run not found" };
        return { ok: true as const, run: serializeRun(run) };
      },
      { params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }) },
    )
    // Cancel a run (stops further steps).
    .post(
      "/runs/:id/cancel",
      async ({ params, request }) => {
        await requireAdmin(ctx, request);
        const updated = await ctx.db
          .update(importRuns)
          .set({ status: "canceled", updatedAt: new Date() })
          .where(eq(importRuns.id, params.id))
          .returning({ id: importRuns.id });
        if (updated.length === 0) return { ok: false as const, error: "Import run not found" };
        return { ok: true as const };
      },
      { params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }) },
    )
    // The most recent runs (admin-only) — for the console's history.
    .get("/runs", async ({ request }) => {
      await requireAdmin(ctx, request);
      const rows = await ctx.db.select().from(importRuns).orderBy(desc(importRuns.id)).limit(10);
      return rows.map(serializeRun);
    });
}

/** Wire shape of a run (timestamps as ISO strings). */
function serializeRun(run: typeof importRuns.$inferSelect) {
  return {
    id: run.id,
    sourceInstance: run.sourceInstance,
    userFilter: run.userFilter,
    sourceTimezone: run.sourceTimezone,
    targetUserId: run.targetUserId,
    maxId: run.maxId,
    cursor: run.cursor,
    imported: run.imported,
    failed: run.failed,
    skipped: run.skipped,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/** Assert the caller is an admin, returning the user (401 anon / 403 non-admin). */
async function requireAdmin(ctx: PluginContext, request: Request): Promise<User> {
  const user = await ctx.auth.currentUser(request);
  if (!user) throw new AuthenticationError();
  if (!canModerate(user)) throw new AuthorizationError();
  return user;
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type ShimmieImportPluginApp = ReturnType<typeof buildImportRoutes>;

/**
 * shimmie2 importer — the first real migration plugin. Pulls posts from a running
 * shimmie via its GraphQL + User-API extensions (over an SSRF-guarded fetch),
 * re-ingesting each through Core's asset pipeline (preserving rating/source/date,
 * attributed to a target user) with a resumable, idempotent run + ledger. Imported
 * assets emit `asset.created`, so the thumbnailer plugin auto-generates their
 * thumbnails. Built on the plugin system (#21) + thumbnailer (#22).
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "Shimmie Import",
  version: "0.1.0",
  migrations: {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsTable: "__drizzle_migrations_shimmie_import",
  },
  register(ctx) {
    return {
      routes: buildImportRoutes(ctx),
      adminPages: [{ id: "shimmie-import", title: "Import from Shimmie" }],
    };
  },
});
