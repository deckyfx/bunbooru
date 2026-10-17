import { ValidationError } from "@bunbooru/plugin-sdk";

/** Longest note text accepted, after trimming. */
export const MAX_BODY = 1000;

/** A note's text: trimmed, 1–{@link MAX_BODY} characters. Throws ValidationError. */
export function normalizeBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError("A note can't be blank");
  if (body.length > MAX_BODY) throw new ValidationError(`A note is at most ${MAX_BODY} characters`);
  return body;
}
