import type { AndNode, CompareOp, MetatagNode, QueryNode } from "./ast";
import { type Token, tokenize } from "./token";

/** Comparison symbols, longest first so `>=` beats `>`. */
const OPERATORS: ReadonlyArray<readonly [string, CompareOp]> = [
  [">=", "gte"],
  ["<=", "lte"],
  [">", "gt"],
  ["<", "lt"],
];

/**
 * A range is `lo..hi` separated by exactly `..`, where neither side contains a
 * scheme/path character — so URL values like `https://a..b` are NOT ranges.
 */
const RANGE_RE = /^[^:/]*\.\.[^:/]*$/;

/**
 * Parse a booru query string into its AST. Semantics:
 * - whitespace-separated terms are AND'd (the implicit top level);
 * - `-term` negates a term;
 * - `~term ~term` form a single OR group, AND'd with the other terms.
 */
export function parse(query: string): AndNode {
  const andChildren: QueryNode[] = [];
  const orChildren: QueryNode[] = [];

  for (const token of tokenize(query)) {
    const node = toNode(token);
    if (token.prefix === "or") {
      orChildren.push(node);
    } else if (token.prefix === "not") {
      andChildren.push({ type: "not", child: node });
    } else {
      andChildren.push(node);
    }
  }

  if (orChildren.length === 1) {
    const [only] = orChildren;
    if (only) andChildren.push(only); // a lone ~term is just that term
  } else if (orChildren.length > 1) {
    andChildren.push({ type: "or", children: orChildren });
  }

  return { type: "and", children: andChildren };
}

function toNode(token: Token): QueryNode {
  if (token.kind === "tag") return { type: "tag", name: token.name };
  return parseMetatag(token.key, token.value);
}

function parseMetatag(key: string, raw: string): MetatagNode {
  // Operators first, so an operator beats a range-looking value (e.g. >10..20).
  for (const [symbol, op] of OPERATORS) {
    if (raw.startsWith(symbol)) {
      return { type: "metatag", key, op, value: raw.slice(symbol.length) };
    }
  }
  if (RANGE_RE.test(raw)) {
    return { type: "metatag", key, op: "range", value: raw };
  }
  return { type: "metatag", key, op: "eq", value: raw };
}
