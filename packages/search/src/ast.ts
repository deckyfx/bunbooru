/**
 * The query AST — the canonical representation a search compiles to. Everything
 * downstream (optimizer, SQL builder) consumes this; nothing else parses text.
 */

/** Comparison operator for a metatag value. */
export type CompareOp = "eq" | "gt" | "gte" | "lt" | "lte" | "range";

/** Boolean AND of its children (the implicit top-level combinator). */
export interface AndNode {
  type: "and";
  children: QueryNode[];
}

/** Boolean OR of its children (formed from `~`-prefixed terms). */
export interface OrNode {
  type: "or";
  children: QueryNode[];
}

/** Negation of a single child (from a `-`-prefixed term). */
export interface NotNode {
  type: "not";
  child: QueryNode;
}

/** A bare tag match (may contain `*` wildcards). */
export interface TagNode {
  type: "tag";
  name: string;
}

/**
 * A metatag filter, e.g. `rating:safe`, `score:>10`, `width:100..200`. For
 * `op: "range"` the `value` is the raw `lo..hi` string.
 */
export interface MetatagNode {
  type: "metatag";
  key: string;
  op: CompareOp;
  value: string;
}

export type QueryNode = AndNode | OrNode | NotNode | TagNode | MetatagNode;
