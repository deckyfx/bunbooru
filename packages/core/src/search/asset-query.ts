import {
  and,
  between,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { assets, assetTags, tags, users, type AssetOrder, type Rating } from "@bunbooru/db";
import {
  collectTagNames,
  optimize,
  parse,
  type MetatagNode,
  type QueryNode,
} from "@bunbooru/search";

import { CORE_METATAG_KEYS, type SearchProviderLookup } from "./providers";
import type { SortProviderLookup } from "./sort-providers";
import { dateRange, DEFAULT_ORDER, parseOrder } from "./terms";

/** Looks up aliases for the given tag names: antecedent → consequent name. */
export type AliasResolver = (names: string[]) => Promise<ReadonlyMap<string, string>>;

/** What the compiler needs from outside the query: aliases, plugin metatags and sort keys. */
export interface SearchContext {
  resolveAliases?: AliasResolver;
  /** Plugin-contributed metatags (`fav:`, `pool:`), consulted for non-Core keys. */
  providers?: SearchProviderLookup;
  /** Plugin-contributed sort keys (`order:score`), consulted for non-Core `order:` values. */
  sortProviders?: SortProviderLookup;
}

/** Plugin conditions, compiled ahead of the (synchronous) SQL build, by term. */
type PluginConditions = ReadonlyMap<string, SQL | undefined>;

/** The identity of a metatag term, for compiling each distinct one once. */
const termKey = (node: MetatagNode) => `${node.key}\u0000${node.op}\u0000${node.value}`;

/** Every metatag in the tree whose key a plugin provides (not Core's own keys). */
function pluginMetatags(node: QueryNode, providers: SearchProviderLookup): MetatagNode[] {
  switch (node.type) {
    case "and":
    case "or":
      return node.children.flatMap((child) => pluginMetatags(child, providers));
    case "not":
      return pluginMetatags(node.child, providers);
    case "metatag":
      return !CORE_METATAG_KEYS.has(node.key) && providers.get(node.key) ? [node] : [];
    case "tag":
      return [];
  }
}

/**
 * Compile the plugin metatags in `tree`, each distinct term once, concurrently.
 * A provider's condition is correlated to the post being matched through
 * `assets.id`. A provider that throws fails the search (it isn't silently
 * dropped, which would quietly widen the results).
 */
async function compilePluginTerms(
  tree: QueryNode,
  providers: SearchProviderLookup | undefined,
): Promise<PluginConditions> {
  if (!providers) return new Map();
  const terms = new Map(pluginMetatags(tree, providers).map((node) => [termKey(node), node]));
  const asset = { id: sql`${assets.id}` };
  const compiled = await Promise.all(
    [...terms].map(async ([key, node]) => {
      const provider = providers.get(node.key);
      // Core's rule for every metatag: a blank value (`fav:` while still typing)
      // is ignored, not "match nothing". Applied here once for every plugin.
      const condition =
        provider && node.value.trim() !== ""
          ? await provider.compile({ op: node.op, value: node.value }, asset)
          : undefined;
      return [key, condition] as const;
    }),
  );
  return new Map(compiled);
}

/** A compiled search: which assets match, and in what order. */
export interface CompiledSearch {
  where: SQL | undefined;
  order: AssetOrder;
}

/**
 * The Search Engine (Core-owned per CLAUDE.md). Compiles a query string into a
 * Drizzle `WHERE` over the assets table: `@bunbooru/search` parses text → AST,
 * and this walks the AST → SQL. `db` never sees text; it only runs the condition.
 *
 *   rating:safe width:>1000 1girl -monochrome
 *     → rating = 'safe' AND width > 1000 AND <tag 1girl> AND NOT <tag monochrome>
 *
 * The full pipeline: parse → take out `order:` → fetch the aliases for exactly
 * the tag names the query mentions (one batched lookup) → optimize (resolve
 * aliases, simplify) → build SQL. Metatags map to asset columns; tag terms
 * compile to an `asset_tags` EXISTS subquery. Without a resolver, aliases are
 * simply not applied. Metatags a plugin provides (`fav:alice`) compile through
 * that plugin's search provider and compose like built-in ones.
 *
 * `order:` sorts rather than filters, so it's lifted out before optimizing,
 * while the top of the parsed tree is still the plain AND of the query's terms.
 * Only a positive, top-level one counts, and the last one wins (`order:views
 * order:size` sorts by size); one inside `-…` or a `~` group is ignored. A
 * non-Core `order:` value may name a plugin sort key (`order:score`); an
 * unknown one keeps the order so far.
 */
export async function compileAssetSearch(
  query: string,
  { resolveAliases, providers, sortProviders }: SearchContext = {},
): Promise<CompiledSearch> {
  const ast = parse(query);
  let order = DEFAULT_ORDER;
  const filters: QueryNode[] = [];
  for (const child of ast.children) {
    if (child.type === "metatag" && child.key === "order") {
      order = (child.op === "eq" && parseOrder(child.value, sortProviders)) || order;
    } else {
      filters.push(child);
    }
  }
  const remaining: QueryNode = { type: "and", children: filters };
  const names = collectTagNames(remaining);
  const aliases = resolveAliases && names.length > 0 ? await resolveAliases(names) : undefined;
  const optimized = optimize(remaining, { aliases });
  const plugin = await compilePluginTerms(optimized, providers);
  return { where: buildNode(optimized, plugin), order };
}

const RATINGS = new Set<Rating>(["safe", "questionable", "explicit", "unrated"]);
const isRating = (value: string): value is Rating => RATINGS.has(value as Rating);

/** Metatag keys that map to a numeric asset column. */
const NUMERIC_COLUMNS = {
  id: assets.id,
  width: assets.width,
  height: assets.height,
  size: assets.sizeBytes,
  views: assets.viewCount,
  tagcount: assets.tagCount,
} as const;

/** A canonical md5 digest, as stored (lowercase hex). */
const MD5_RE = /^[0-9a-f]{32}$/;
type NumericColumn = (typeof NUMERIC_COLUMNS)[keyof typeof NUMERIC_COLUMNS];

function buildNode(node: QueryNode, plugin: PluginConditions): SQL | undefined {
  switch (node.type) {
    case "and":
      // Drizzle's and/or drop undefined args, so unknown/empty terms just vanish.
      return and(...node.children.map((child) => buildNode(child, plugin)));
    case "or":
      return or(...node.children.map((child) => buildNode(child, plugin)));
    case "not": {
      const child = buildNode(node.child, plugin);
      return child ? not(child) : undefined;
    }
    case "tag":
      return tagCondition(node.name);
    case "metatag":
      // A plugin term was compiled up front; Core keys never reach providers.
      return plugin.has(termKey(node)) ? plugin.get(termKey(node)) : metatagCondition(node);
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

/**
 * One metatag as a condition. A term that can't be understood (unknown key,
 * malformed value, operator that doesn't apply) compiles to nothing and is
 * ignored, like an unknown key always has been. A well-formed term that simply
 * matches no rows (`user:nobody`) is a real condition that matches nothing.
 */
function metatagCondition(node: MetatagNode): SQL | undefined {
  if (node.value.trim() === "") return undefined;

  switch (node.key) {
    case "rating":
      // Only equality is meaningful for an enum.
      return node.op === "eq" && isRating(node.value) ? eq(assets.rating, node.value) : undefined;
    case "md5": {
      const digest = node.value.toLowerCase();
      return node.op === "eq" && MD5_RE.test(digest) ? eq(assets.md5, digest) : undefined;
    }
    case "user":
      // Compared as lower(username): that's what users_username_lower_idx
      // indexes, and it holds even if a write path ever stored mixed case. An
      // unknown user matches no posts. The explicit NOT NULL keeps `-user:alice`
      // honest: a bare `NOT IN` is NULL (not true) for a post with no uploader,
      // which would silently drop it.
      return node.op === "eq"
        ? and(
            isNotNull(assets.uploaderId),
            inArray(
              assets.uploaderId,
              sql`(select ${users.id} from ${users} where lower(${users.username}) = ${node.value.toLowerCase()})`,
            ),
          )
        : undefined;
    case "date": {
      const range = dateRange(node.op, node.value);
      if (!range) return undefined;
      return and(
        range.from ? gte(assets.createdAt, range.from) : undefined,
        range.until ? lt(assets.createdAt, range.until) : undefined,
      );
    }
    case "order":
      // Lifted out by compileAssetSearch when it applies; anywhere else (negated,
      // inside an OR group) it has no meaning as a filter.
      return undefined;
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
