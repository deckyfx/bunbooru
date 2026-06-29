import { and, between, eq, gt, gte, lt, lte, not, or, sql, type SQL } from "drizzle-orm";

import { assets, assetTags, tags, type Rating } from "@bunbooru/db";
import { parse, type MetatagNode, type QueryNode } from "@bunbooru/search";

/**
 * The Search Engine (Core-owned per CLAUDE.md). Compiles a query string into a
 * Drizzle `WHERE` over the assets table: `@bunbooru/search` parses text → AST,
 * and this walks the AST → SQL. `db` never sees text; it only runs the condition.
 *
 *   rating:safe width:>1000 1girl -monochrome
 *     → rating = 'safe' AND width > 1000 AND <tag 1girl> AND NOT <tag monochrome>
 *
 * Metatags map to asset columns and filter immediately. Tag terms compile to an
 * `asset_tags` EXISTS subquery — valid SQL today, matching once tagging lands.
 */
export function compileAssetSearch(query: string): SQL | undefined {
  return buildNode(parse(query));
}

const RATINGS = new Set<Rating>(["safe", "questionable", "explicit", "unrated"]);
const isRating = (value: string): value is Rating => RATINGS.has(value as Rating);

/** Metatag keys that map to a numeric asset column. */
const NUMERIC_COLUMNS = {
  width: assets.width,
  height: assets.height,
  size: assets.sizeBytes,
} as const;
type NumericColumn = (typeof NUMERIC_COLUMNS)[keyof typeof NUMERIC_COLUMNS];

function buildNode(node: QueryNode): SQL | undefined {
  switch (node.type) {
    case "and":
      // Drizzle's and/or drop undefined args, so unknown/empty terms just vanish.
      return and(...node.children.map(buildNode));
    case "or":
      return or(...node.children.map(buildNode));
    case "not": {
      const child = buildNode(node.child);
      return child ? not(child) : undefined;
    }
    case "tag":
      return tagCondition(node.name);
    case "metatag":
      return metatagCondition(node);
  }
}

/** Escape LIKE metacharacters, then map the tag glob `*` to SQL `%`. */
function likePattern(name: string): string {
  return name.replace(/[\\%_]/g, "\\$&").replace(/\*/g, "%");
}

/** An asset has a tag matching `name` (supports `*` wildcards). */
function tagCondition(name: string): SQL {
  const match = name.includes("*")
    ? sql`${tags.name} like ${likePattern(name)}`
    : sql`${tags.name} = ${name}`;
  return sql`exists (select 1 from ${assetTags} inner join ${tags} on ${assetTags.tagId} = ${tags.id} where ${assetTags.assetId} = ${assets.id} and ${match})`;
}

function metatagCondition(node: MetatagNode): SQL | undefined {
  if (node.key === "rating") {
    // Only equality is meaningful for an enum; an invalid value matches nothing.
    return node.op === "eq" && isRating(node.value) ? eq(assets.rating, node.value) : undefined;
  }

  const column = NUMERIC_COLUMNS[node.key as keyof typeof NUMERIC_COLUMNS];
  if (!column) return undefined; // unknown metatag key → ignored

  if (node.op === "range") return rangeCondition(column, node.value);

  const n = Number(node.value);
  if (!Number.isFinite(n)) return undefined;
  switch (node.op) {
    case "eq":
      return eq(column, n);
    case "gt":
      return gt(column, n);
    case "gte":
      return gte(column, n);
    case "lt":
      return lt(column, n);
    case "lte":
      return lte(column, n);
    default:
      return undefined;
  }
}

/** `lo..hi`, `lo..`, or `..hi` → bounded/half-open numeric range. */
function rangeCondition(column: NumericColumn, value: string): SQL | undefined {
  // Exactly one `..` separates the bounds; anything else (e.g. `1..2..3`) is
  // malformed and ignored rather than silently truncated to the first two parts.
  const parts = value.split("..");
  if (parts.length !== 2) return undefined;
  const [loRaw, hiRaw] = parts;
  const lo = loRaw ? Number(loRaw) : undefined;
  const hi = hiRaw ? Number(hiRaw) : undefined;
  if ((lo !== undefined && !Number.isFinite(lo)) || (hi !== undefined && !Number.isFinite(hi))) {
    return undefined;
  }
  if (lo !== undefined && hi !== undefined) return between(column, lo, hi);
  if (lo !== undefined) return gte(column, lo);
  if (hi !== undefined) return lte(column, hi);
  return undefined;
}
