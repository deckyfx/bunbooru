/** One keyset page as the Core asset listing returns it (only what the walk needs). */
export interface CursorPage<T> {
  assets: T[];
  nextCursor: string | null;
}

/**
 * Visit a cursor-paginated listing page by page, in order, until it runs out
 * or `visit` returns `"stop"`. Each call to `list` gets the previous page's
 * `nextCursor` (none for the first). Kept separate from the backfill so the
 * walk itself can be tested without a database.
 */
export async function walkPages<T>(
  list: (cursor: string | undefined) => Promise<CursorPage<T>>,
  visit: (items: T[]) => Promise<"continue" | "stop">,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await list(cursor);
    if (page.assets.length === 0) return;
    if ((await visit(page.assets)) === "stop") return;
    if (page.nextCursor === null) return;
    cursor = page.nextCursor;
  }
}
