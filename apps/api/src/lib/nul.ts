/** Deepest nesting {@link containsNul} walks; request bodies here are shallow. */
const MAX_DEPTH = 8;

/**
 * Whether any string inside `value` (a parsed body, query or path params)
 * contains a NUL character. Postgres `text` can't store U+0000, so a NUL that
 * reached a write would fail it with a 500; rejecting it up front makes that a
 * 400 for every route, Core's and plugins' alike. Files and other non-plain
 * values (an upload's bytes) are not inspected.
 */
export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsNul(item, depth + 1));
  // Plain objects only: a File/Blob in a multipart body is binary, not text.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).some((item) => containsNul(item, depth + 1));
}
