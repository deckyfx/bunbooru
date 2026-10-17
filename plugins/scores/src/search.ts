import { sql, type SQL } from "drizzle-orm";

import type { SearchProvider } from "@bunbooru/plugin-sdk";

import { totals } from "./schema";
import { parseScoreTerm, scoreMatches, type ScoreFilter } from "./search-term";

/**
 * `filter` as a condition on `scores_totals.score`. Bounds are cast to bigint
 * so any safe integer compares cleanly against the int column (an int4 param
 * would reject `score:>9999999999`); int4/int8 comparisons still use the index.
 */
function scoreCondition(filter: ScoreFilter): SQL {
  const score = totals.score;
  if (filter.kind === "range") {
    const lo = filter.lo === undefined ? sql`true` : sql`${score} >= ${filter.lo}::bigint`;
    const hi = filter.hi === undefined ? sql`true` : sql`${score} <= ${filter.hi}::bigint`;
    return sql`(${lo} and ${hi})`;
  }
  const n = sql`${filter.n}::bigint`;
  switch (filter.op) {
    case "eq":
      return sql`${score} = ${n}`;
    case "gt":
      return sql`${score} > ${n}`;
    case "gte":
      return sql`${score} >= ${n}`;
    case "lt":
      return sql`${score} < ${n}`;
    case "lte":
      return sql`${score} <= ${n}`;
  }
}

/**
 * `score:>10`, `score:0`, `score:-5..5`: posts by net score, with Core's
 * numeric operators. A post nobody voted on has no totals row and scores 0.
 *
 * Rather than `coalesce((select score …), 0) > N`, the zero case is decided
 * here: when 0 doesn't match, a post needs a totals row whose score does
 * (`exists`, which the planner can turn into a semi-join over the score
 * index); when 0 does match, a post matches unless it has a row whose score
 * doesn't (`not exists`). Same results, and the selective case stays cheap at
 * millions of posts. A non-integer value is ignored.
 */
export function scoreSearch(): SearchProvider {
  return {
    key: "score",
    compile(term, asset) {
      const filter = parseScoreTerm(term);
      if (!filter) return undefined;
      const condition = scoreCondition(filter);
      return scoreMatches(filter, 0)
        ? sql`not exists (select 1 from ${totals} where ${totals.assetId} = ${asset.id} and not (${condition}))`
        : sql`exists (select 1 from ${totals} where ${totals.assetId} = ${asset.id} and (${condition}))`;
    },
  };
}
