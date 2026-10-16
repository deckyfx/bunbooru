import { describe, expect, it } from "bun:test";

import { walkPages, type CursorPage } from "../src/walk-pages";

/** A listing of `pages`, recording the cursor each call received. */
function listing(pages: CursorPage<number>[]) {
  const cursors: (string | undefined)[] = [];
  const list = async (cursor: string | undefined) => {
    cursors.push(cursor);
    const index = cursor === undefined ? 0 : Number(cursor.slice(1));
    return pages[index] ?? { assets: [], nextCursor: null };
  };
  return { list, cursors };
}

describe("walkPages", () => {
  it("follows nextCursor across pages and visits every item once, in order", async () => {
    const { list, cursors } = listing([
      { assets: [1, 2], nextCursor: "p1" },
      { assets: [3, 4], nextCursor: "p2" },
      { assets: [5], nextCursor: null },
    ]);
    const seen: number[] = [];
    await walkPages(list, async (items) => {
      seen.push(...items);
      return "continue";
    });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(cursors).toEqual([undefined, "p1", "p2"]); // each call got the previous nextCursor
  });

  it("stops as soon as the visitor says so, fetching no further page", async () => {
    const { list, cursors } = listing([
      { assets: [1, 2], nextCursor: "p1" },
      { assets: [3], nextCursor: null },
    ]);
    await walkPages(list, async () => "stop");
    expect(cursors).toEqual([undefined]);
  });

  it("ends on an empty page even if it carries a cursor", async () => {
    const { list, cursors } = listing([{ assets: [], nextCursor: "p1" }]);
    let visits = 0;
    await walkPages(list, async () => {
      visits += 1;
      return "continue";
    });
    expect(visits).toBe(0);
    expect(cursors).toEqual([undefined]);
  });
});
