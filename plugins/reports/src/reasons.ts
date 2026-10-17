import { ValidationError } from "@bunbooru/plugin-sdk";

/** Longest report reason, and longest moderator note, accepted. */
export const MAX_REASON = 500;
export const MAX_NOTE = 500;

/** What the queue records when a post is deleted with reports still open. */
export const POST_DELETED_RESOLUTION = "Post deleted";

/** A reporter's reason: trimmed, 1–{@link MAX_REASON} characters. Throws ValidationError. */
export function normalizeReason(raw: string): string {
  const reason = raw.trim();
  if (reason.length === 0) throw new ValidationError("Say why you're reporting this post");
  if (reason.length > MAX_REASON) throw new ValidationError(`A reason is at most ${MAX_REASON} characters`);
  return reason;
}

/**
 * A moderator's optional note (a dismissal's resolution, a deletion's reason):
 * trimmed, at most {@link MAX_NOTE} characters, blank or absent as null.
 * Throws ValidationError.
 */
export function normalizeNote(raw: string | undefined): string | null {
  const note = raw?.trim() ?? "";
  if (note.length > MAX_NOTE) throw new ValidationError(`A note is at most ${MAX_NOTE} characters`);
  return note || null;
}
