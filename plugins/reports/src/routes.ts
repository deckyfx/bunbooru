import { Elysia, NotFoundError, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  ConflictError,
  pluginRoutePrefix,
  type PluginContext,
  type User,
} from "@bunbooru/plugin-sdk";

import { normalizeNote, normalizeReason, POST_DELETED_RESOLUTION } from "./reasons";
import type { ReportRow } from "./schema";
import {
  closeReport,
  createReport,
  findReport,
  listReports,
  openReportsForAsset,
  resolveOpenForAsset,
} from "./store";

export const PLUGIN_ID = "reports";

const idParam = t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 });

/**
 * Raw text bound for reasons and notes. Looser than the stored limit so
 * surrounding whitespace doesn't fail validation; the normalizers enforce the
 * real limit after trimming (a 400 with a readable message).
 */
const textInput = t.String({ maxLength: 2000 });

/** Page size for the moderator queue. */
const QUEUE_LIMIT = 50;

/** A report, as the routes return it. */
function serializeReport(report: ReportRow) {
  return {
    id: report.id,
    assetId: report.assetId,
    reporterName: report.reporterName,
    reason: report.reason,
    status: report.status,
    resolution: report.resolution,
    resolvedByName: report.resolvedByName,
    createdAt: report.createdAt.toISOString(),
    resolvedAt: report.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * The reports routes, under `/api/v1/plugins/reports`. Any signed-in user may
 * report a post; the queue and every action on it are moderators only,
 * checked here whatever the UI shows.
 */
export function buildReportsRoutes(ctx: PluginContext) {
  /** The caller, or 401. */
  const requireUser = async (request: Request): Promise<User> => {
    const user = await ctx.auth.currentUser(request);
    if (!user) throw new AuthenticationError();
    return user;
  };
  /** The caller, if they may moderate; else 401/403. */
  const requireModerator = async (request: Request): Promise<User> => {
    const user = await requireUser(request);
    if (!canModerate(user)) throw new AuthorizationError();
    return user;
  };

  return (
    new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
      // Report a post. One open report per user per post.
      .post(
        "/assets/:id",
        async ({ request, params, body, set }) => {
          const user = await requireUser(request);
          const reason = normalizeReason(body.reason);
          if (!(await ctx.services.assets.getById(params.id))) throw new NotFoundError("Post not found");
          const report = await createReport(ctx.db, {
            assetId: params.id,
            reporterId: user.id,
            reporterName: user.username,
            reason,
          });
          ctx.log.info("post_reported", { id: report.id, assetId: params.id, by: user.username });
          set.status = 201;
          return serializeReport(report);
        },
        { params: t.Object({ id: idParam }), body: t.Object({ reason: textInput }) },
      )
      // The moderator queue: one status (default open), newest first.
      // `before` is the last id of the previous page.
      .get(
        "/queue",
        async ({ request, query }) => {
          await requireModerator(request);
          const rows = await listReports(ctx.db, {
            status: query.status ?? "open",
            before: query.before,
            limit: QUEUE_LIMIT + 1,
          });
          const items = rows.slice(0, QUEUE_LIMIT);
          return {
            items: items.map(serializeReport),
            nextBefore: rows.length > QUEUE_LIMIT ? (items.at(-1)?.id ?? null) : null,
          };
        },
        {
          query: t.Object({
            status: t.Optional(t.Union([t.Literal("open"), t.Literal("resolved"), t.Literal("dismissed")])),
            before: t.Optional(idParam),
          }),
        },
      )
      // A post's open reports (the moderator's view from the post page).
      .get(
        "/assets/:id",
        async ({ request, params }) => {
          await requireModerator(request);
          const rows = await openReportsForAsset(ctx.db, params.id);
          return { items: rows.map(serializeReport) };
        },
        { params: t.Object({ id: idParam }) },
      )
      // Turn a report down, optionally saying why.
      .post(
        "/reports/:id/dismiss",
        async ({ request, params, body }) => {
          const user = await requireModerator(request);
          const resolution = normalizeNote(body.note);
          if (!(await findReport(ctx.db, params.id))) throw new NotFoundError("Report not found");
          const closed = await closeReport(ctx.db, params.id, {
            status: "dismissed",
            resolution,
            resolvedByName: user.username,
          });
          if (!closed) throw new ConflictError("That report isn't open");
          ctx.log.info("report_dismissed", { id: params.id, by: user.username });
          return serializeReport(closed);
        },
        { params: t.Object({ id: idParam }), body: t.Object({ note: t.Optional(textInput) }) },
      )
      // Delete the reported post for good, and resolve its open reports BEFORE
      // answering, so the queue the moderator reloads next already shows them
      // closed. (The `asset.deleted` listener does the same, idempotently, for
      // posts deleted elsewhere; on its own it may land after the reload.)
      .post(
        "/assets/:id/delete",
        async ({ request, params, body, set }) => {
          const user = await requireModerator(request);
          const reason = normalizeNote(body.reason) ?? "";
          if (!(await ctx.services.assets.delete(params.id, { deletedById: user.id, reason }))) {
            throw new NotFoundError("Post not found");
          }
          await resolveOpenForAsset(ctx.db, params.id, POST_DELETED_RESOLUTION);
          ctx.log.info("reported_post_deleted", { assetId: params.id, by: user.username });
          set.status = 204;
          return "";
        },
        { params: t.Object({ id: idParam }), body: t.Object({ reason: t.Optional(textInput) }) },
      )
  );
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type ReportsPluginApp = ReturnType<typeof buildReportsRoutes>;
