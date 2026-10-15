import type { QueryNode } from "./ast";

/** What the optimizer needs to know about the tag vocabulary. */
export interface OptimizeOptions {
  /**
   * Alias map: antecedent tag name → consequent tag name (`kitty` → `cat`). Core
   * builds it from the database for exactly the names {@link collectTagNames}
   * reports, so this package stays pure.
   */
  aliases?: ReadonlyMap<string, string>;
}

/** A tag term with `*` is a name pattern, not one tag: aliases never apply to it. */
const isPattern = (name: string): boolean => name.includes("*");

/**
 * The optimizer stage: AST → equivalent, canonical AST. Pure; returns a new tree
 * and never mutates its input.
 *
 * - **Aliases:** an exact tag term naming an aliased tag is rewritten to the tag
 *   it's aliased to, so `kitty` finds the posts that were migrated to `cat`.
 * - **Simplification:** nested groups of the same kind flatten into their
 *   parent, duplicate terms drop (first occurrence wins, so order stays stable),
 *   a one-child group becomes its child, and a double negation cancels. An empty
 *   AND survives: it means "no constraint".
 *
 * Aliases are resolved before deduplication, so `kitty cat` collapses to `cat`.
 */
export function optimize(node: QueryNode, options: OptimizeOptions = {}): QueryNode {
  const aliases = options.aliases ?? new Map<string, string>();
  return visit(node, aliases);
}

function visit(node: QueryNode, aliases: ReadonlyMap<string, string>): QueryNode {
  switch (node.type) {
    case "tag":
      return isPattern(node.name)
        ? { ...node }
        : { type: "tag", name: aliases.get(node.name) ?? node.name };
    case "metatag":
      return { ...node };
    case "not": {
      const child = visit(node.child, aliases);
      return child.type === "not" ? child.child : { type: "not", child };
    }
    case "and":
    case "or": {
      const children: QueryNode[] = [];
      const seen = new Set<string>();
      for (const raw of node.children) {
        const child = visit(raw, aliases);
        // Same-kind nesting is associative, so splice the grandchildren in.
        const spliced = child.type === node.type ? child.children : [child];
        for (const item of spliced) {
          const key = JSON.stringify(item);
          if (seen.has(key)) continue;
          seen.add(key);
          children.push(item);
        }
      }
      if (children.length === 1) return children[0]!;
      return { type: node.type, children };
    }
  }
}

/**
 * Every exact tag name the query mentions, once each, in first-seen order.
 * Patterns (`cat*`) and metatags are skipped. Core uses this to fetch the aliases
 * for a query in one batched lookup before calling {@link optimize}.
 */
export function collectTagNames(node: QueryNode): string[] {
  const names = new Set<string>();
  const walk = (current: QueryNode): void => {
    switch (current.type) {
      case "tag":
        if (!isPattern(current.name)) names.add(current.name);
        return;
      case "metatag":
        return;
      case "not":
        walk(current.child);
        return;
      case "and":
      case "or":
        for (const child of current.children) walk(child);
    }
  };
  walk(node);
  return [...names];
}
