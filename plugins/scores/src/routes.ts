import { Elysia, NotFoundError, t } from "elysia";

import { AuthenticationError, pluginRoutePrefix, type PluginContext } from "@bunbooru/plugin-sdk";

import { castVote, removeAssetScores, scoreStatus } from "./store";
import type { ScoreStatus } from "./votes";

/** This plugin's stable id: its route-prefix segment and migrations suffix. */
export const PLUGIN_ID = "scores";

/** A post id path param, the same bounds as Core's. */
const assetParam = t.Object({
  id: t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }),
});

/** A vote body: up, down, or 0 to take the vote back. Anything else is a 422. */
const voteBody = t.Object({ value: t.Union([t.Literal(-1), t.Literal(0), t.Literal(1)]) });

/**
 * The scores routes, under `/api/v1/plugins/scores`. Reading a post's score is
 * public; voting needs a signed-in user (401 otherwise), and a user only ever
 * sets their own vote. Voting on your own post is allowed.
 */
export function buildScoresRoutes(ctx: PluginContext) {
  /** 404 unless the post exists. */
  const requireAsset = async (assetId: number): Promise<void> => {
    if (!(await ctx.services.assets.getById(assetId))) throw new NotFoundError("Post not found");
  };

  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    .get(
      "/assets/:id",
      async ({ params, request }): Promise<ScoreStatus> => {
        await requireAsset(params.id);
        const user = await ctx.auth.currentUser(request);
        return scoreStatus(ctx.db, params.id, user?.id ?? null);
      },
      { params: assetParam },
    )
    .put(
      "/assets/:id",
      async ({ params, body, request }): Promise<ScoreStatus> => {
        const user = await ctx.auth.currentUser(request);
        if (!user) throw new AuthenticationError();
        await requireAsset(params.id);
        const status = await castVote(ctx.db, params.id, user.id, body.value);
        // The post may have been deleted between the check above and the vote
        // committing, after its `asset.deleted` cleanup already ran: undo the
        // vote's rows rather than leave them orphaned (idempotent either way).
        if (!(await ctx.services.assets.getById(params.id))) {
          await removeAssetScores(ctx.db, params.id);
          throw new NotFoundError("Post not found");
        }
        return status;
      },
      { params: assetParam, body: voteBody },
    );
}

/** Server type for a typed Eden Treaty client on the web (paths incl. the prefix). */
export type ScoresPluginApp = ReturnType<typeof buildScoresRoutes>;
