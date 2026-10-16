/** One keyset page as the Core asset listing returns it (only what the walk needs). */
export interface CursorPage<T> {
  assets: T[];
  nextCursor: string | null;
}

/**
 * Visit a cursor-paginated listing page by page, in order, from `from` (the
 * start when absent), until it runs out or `visit` returns `"stop"`. Each call
 * to `list` gets the previous page's `nextCursor`. Returns the cursor to resume
 * from when `visit` stopped the walk with pages still left, otherwise null.
 * Kept separate from the backfill so the walk can be tested without a database.
 */
export async function walkPages<T>(
  list: (cursor: string | undefined) => Promise<CursorPage<T>>,
  visit: (items: T[]) => Promise<"continue" | "stop">,
  from?: string,
): Promise<string | null> {
  let cursor = from;
  for (;;) {
    const page = await list(cursor);
    if (page.assets.length === 0) return null;
    const next = await visit(page.assets);
    if (page.nextCursor === null) return null;
    if (next === "stop") return page.nextCursor;
    cursor = page.nextCursor;
  }
}
