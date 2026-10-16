import { describe, expect, it } from "bun:test";

import { thumbnailKey } from "../src/index";

describe("thumbnailKey", () => {
  it("shards two levels deep by the id's low 16 bits", () => {
    expect(thumbnailKey(1)).toBe("00/01/1.webp");
    expect(thumbnailKey(0xabcd)).toBe("ab/cd/43981.webp");
    // Above 16 bits only the low bits pick the shard: 0x1_0001 sits beside 1.
    expect(thumbnailKey(0x1_0001)).toBe("00/01/65537.webp");
  });

  it("spreads sequential ids evenly across leaf directories", () => {
    const leaves = new Map<string, number>();
    for (let id = 1; id <= 65_536 * 3; id++) {
      const leaf = thumbnailKey(id).split("/").slice(0, 2).join("/");
      leaves.set(leaf, (leaves.get(leaf) ?? 0) + 1);
    }
    expect(leaves.size).toBe(65_536);
    expect(new Set(leaves.values())).toEqual(new Set([3]));
  });
});
