/**
 * Wiki body markup: plain text with exactly two constructs, `[[Title]]` (a link
 * to another wiki page) and `{{tag}}` (a link to a post search). Everything
 * else, HTML included, is literal text; the web renders the tokens as React
 * elements, so a body can never inject markup.
 *
 * Pure and dependency-free: the web imports this module
 * (`@bunbooru/plugin-wiki/markup`), and the server could validate with it.
 */
import { parseTitle } from "./title";

/** A run of literal text, newlines included. */
export interface TextToken {
  type: "text";
  text: string;
}

/** `[[Blue Sky]]`: a link to the page `blue_sky`, labelled as written. */
export interface WikiLinkToken {
  type: "wiki";
  title: string;
  label: string;
}

/** `{{blue_sky}}`: a link to the post search `blue_sky`, labelled as written. */
export interface SearchLinkToken {
  type: "search";
  tag: string;
  label: string;
}

export type MarkupToken = TextToken | WikiLinkToken | SearchLinkToken;

/**
 * A link: `[[…]]` or `{{…}}` around 1–200 characters that are neither a
 * square or curly bracket nor a newline (so a title holding a bracket can't be
 * linked). Excluding the brackets makes the innermost pair win (`[[a [[b]] c]]`
 * links only `b`) and keeps the scan linear: the classes never overlap the
 * delimiters, so there's no backtracking.
 */
const LINK = /\[\[([^[\]{}\n]{1,200})\]\]|\{\{([^[\]{}\n]{1,200})\}\}/g;

/**
 * Split a body into tokens. A link whose inside isn't a valid title (blank,
 * `*`, too long) stays literal text, as does anything unclosed. Adjacent text
 * is merged, so text tokens never sit side by side.
 */
export function tokenize(body: string): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  const pushText = (text: string) => {
    if (text.length === 0) return;
    const last = tokens.at(-1);
    if (last?.type === "text") last.text += text;
    else tokens.push({ type: "text", text });
  };

  let cursor = 0;
  for (const match of body.matchAll(LINK)) {
    const [whole, wikiInner, searchInner] = match;
    const inner = wikiInner ?? searchInner ?? "";
    const parsed = parseTitle(inner);
    pushText(body.slice(cursor, match.index));
    if (!parsed.ok) pushText(whole);
    else if (wikiInner !== undefined) tokens.push({ type: "wiki", title: parsed.title, label: inner.trim() });
    else tokens.push({ type: "search", tag: parsed.title, label: inner.trim() });
    cursor = match.index + whole.length;
  }
  pushText(body.slice(cursor));
  return tokens;
}

/** The visible length of a token: its text, or a link's label. */
function visibleLength(token: MarkupToken): number {
  return token.type === "text" ? token.text.length : token.label.length;
}

/**
 * The start of a tokenized body, about `max` visible characters long, for a
 * preview. Text is cut at a word boundary when one is near and marked with
 * `…`; a link is kept whole or dropped, never split. `truncated` says whether
 * anything was left out.
 */
export function excerpt(tokens: readonly MarkupToken[], max: number): { tokens: MarkupToken[]; truncated: boolean } {
  const out: MarkupToken[] = [];
  let budget = max;
  for (const token of tokens) {
    const length = visibleLength(token);
    if (length <= budget) {
      out.push(token);
      budget -= length;
      continue;
    }
    if (token.type === "text" && budget > 0) {
      const cut = token.text.slice(0, budget);
      const space = cut.search(/\s\S*$/);
      // Back up to the last space unless that would drop most of the cut.
      const text = (space > budget / 2 ? cut.slice(0, space) : cut).trimEnd();
      out.push({ type: "text", text: `${text}…` });
    } else {
      const last = out.at(-1);
      if (last?.type === "text") out[out.length - 1] = { type: "text", text: `${last.text.trimEnd()}…` };
      else out.push({ type: "text", text: "…" });
    }
    return { tokens: out, truncated: true };
  }
  return { tokens: out, truncated: false };
}
