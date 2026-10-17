/** Whether a value is a plain object (not a File/Blob or other class instance). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether any string inside `value` (a parsed body, query or path params),
 * including object KEYS, contains a NUL character. Postgres `text` can't store
 * U+0000, so a NUL that reached a write would fail it with a 500; rejecting it
 * up front makes that a 400 for every route, Core's and plugins' alike.
 *
 * Walks every plain array and object iteratively, at any depth: no depth cut
 * a deeply nested NUL could hide behind, and no recursion to overflow. The
 * walk is bounded by the request body size cap. Files and other non-plain
 * values (an upload's bytes) are not inspected.
 */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes("\u0000")) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      // A loop, not `push(...current)`: spreading a huge array as arguments
      // can overflow the call stack.
      for (const item of current) pending.push(item);
      continue;
    }
    if (!isPlainObject(current)) continue;
    for (const [key, item] of Object.entries(current)) {
      if (key.includes("\u0000")) return true;
      pending.push(item);
    }
  }
  return false;
}
