import { sql } from "drizzle-orm";

import type { SortProvider } from "@bunbooru/plugin-sdk";

import { totals } from "./schema";

/**
 * `order:score` (highest first) and `order:score_asc` (lowest first): posts by
 * net score. A post nobody voted on has no totals row and sorts as 0, between
 * the upvoted and the downvoted ones. One primary-key lookup per post, the
 * same correlation the `score:` metatag uses.
 */
export function scoreSort(): SortProvider {
  return {
    key: "score",
    value: (asset) =>
      sql`coalesce((select ${totals.score} from ${totals} where ${totals.assetId} = ${asset.id}), 0)`,
  };
}
