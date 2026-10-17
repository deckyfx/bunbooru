import { ValidationError } from "@bunbooru/plugin-sdk";

/** Longest comment accepted, after trimming. */
export const MAX_BODY = 2000;

/** A comment's text: trimmed, 1–{@link MAX_BODY} characters. Throws ValidationError. */
export function normalizeBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError("A comment can't be blank");
  if (body.length > MAX_BODY) throw new ValidationError(`A comment is at most ${MAX_BODY} characters`);
  return body;
}

/**
 * Whether a comment has been edited since it was posted. Any later
 * `updatedAt` counts: the create path sets both columns from one `now()`, so
 * they're equal until an edit.
 */
export function isEdited(comment: { createdAt: Date; updatedAt: Date }): boolean {
  return comment.updatedAt.getTime() > comment.createdAt.getTime();
}
