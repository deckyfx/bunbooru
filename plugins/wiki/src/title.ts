/**
 * Wiki page titles. A title is a tag name, normalized exactly as Core
 * normalizes one (`normalizeTagName` / `requireTagName`: trimmed, lowercased,
 * whitespace runs → `_`, 1–100 characters, no `*`), so a tag's page is found
 * by the tag's own name.
 *
 * Pure and dependency-free: the web imports this module too
 * (`@bunbooru/plugin-wiki/title`), so both sides agree on what a title is.
 */

/** Longest title, after normalization (Core's `MAX_TAG_LENGTH`). */
export const MAX_TITLE = 100;

/** A raw title, normalized, or why it isn't one. */
export type TitleResult = { ok: true; title: string } | { ok: false; reason: string };

/** ASCII/C1 control characters: never part of a name (and NUL can't be stored). */
const CONTROL = /\p{Cc}/u;

/**
 * Normalize `raw` into a page title, or explain why it can't be one. Beyond
 * Core's tag rule, control characters and the path segments `.`/`..` are
 * refused: neither can be a sensible tag, and `.`/`..` can't survive in a URL.
 */
export function parseTitle(raw: string): TitleResult {
  const title = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (title.length === 0) return { ok: false, reason: "A title can't be blank" };
  if (title.length > MAX_TITLE) return { ok: false, reason: `A title is at most ${MAX_TITLE} characters` };
  if (title.includes("*")) return { ok: false, reason: `A title can't contain "*"` };
  if (CONTROL.test(title)) return { ok: false, reason: "A title can't contain control characters" };
  if (title === "." || title === "..") return { ok: false, reason: `A title can't be "${title}"` };
  return { ok: true, title };
}

/**
 * The tag a gallery search is for, when it's exactly ONE plain tag: no other
 * terms, no `-`/`~` modifier, no metatag `key:` (a colon after the first
 * character, as Core's search lexer reads one), no `*` wildcard. Its title, or
 * null for an empty or any other query.
 */
export function plainSearchTag(query: string): string | null {
  const term = query.trim();
  if (term.length === 0 || /\s/.test(term)) return null;
  if (term.startsWith("-") || term.startsWith("~")) return null;
  if (term.indexOf(":") > 0) return null;
  const parsed = parseTitle(term);
  return parsed.ok ? parsed.title : null;
}

/** A title for display: underscores read as spaces (`blue_sky` → `blue sky`). */
export function displayTitle(title: string): string {
  return title.replace(/_/g, " ");
}
