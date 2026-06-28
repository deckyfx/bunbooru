/**
 * Lexer — turns a query string into a flat list of classified terms. Each
 * whitespace-separated term is a tag or a metatag, carrying its modifier prefix.
 */

/** Term modifier prefix: plain, negated (`-`), or or-group member (`~`). */
export type Prefix = "none" | "not" | "or";

export interface TagToken {
  kind: "tag";
  prefix: Prefix;
  name: string;
}

export interface MetatagToken {
  kind: "metatag";
  prefix: Prefix;
  key: string;
  value: string;
}

export type Token = TagToken | MetatagToken;

/** Tokenize a query string into classified terms (empty/blank terms dropped). */
export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  for (const term of query.split(/\s+/)) {
    const token = classify(term);
    if (token) tokens.push(token);
  }
  return tokens;
}

function classify(term: string): Token | null {
  let prefix: Prefix = "none";
  let rest = term;

  if (rest.startsWith("-")) {
    prefix = "not";
    rest = rest.slice(1);
  } else if (rest.startsWith("~")) {
    prefix = "or";
    rest = rest.slice(1);
  }

  if (rest.length === 0) return null; // bare "", "-", or "~"

  // A metatag has a non-empty key before the first colon.
  const colon = rest.indexOf(":");
  if (colon > 0) {
    return {
      kind: "metatag",
      prefix,
      key: rest.slice(0, colon).toLowerCase(),
      value: rest.slice(colon + 1),
    };
  }

  return { kind: "tag", prefix, name: rest.toLowerCase() };
}
