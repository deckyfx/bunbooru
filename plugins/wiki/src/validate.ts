import { ValidationError } from "@bunbooru/plugin-sdk";

import { parseTitle } from "./title";

/** Longest page body accepted, after trimming. */
export const MAX_BODY = 20_000;

/** A page's text: trimmed, 1–{@link MAX_BODY} characters. Throws ValidationError (400). */
export function normalizeBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError("A wiki page can't be blank");
  if (body.length > MAX_BODY) throw new ValidationError(`A wiki page is at most ${MAX_BODY} characters`);
  return body;
}

/** A raw title, normalized, or a ValidationError (400) saying why it isn't one. */
export function requireTitle(raw: string): string {
  const parsed = parseTitle(raw);
  if (!parsed.ok) throw new ValidationError(parsed.reason);
  return parsed.title;
}
