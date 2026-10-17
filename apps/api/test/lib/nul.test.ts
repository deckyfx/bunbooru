import { describe, expect, it } from "bun:test";

import { containsNul } from "../../src/lib/nul";

describe("containsNul", () => {
  it("finds a NUL in a string at any depth of plain data", () => {
    expect(containsNul("a\u0000b")).toBe(true);
    expect(containsNul({ body: "ok", nested: { tags: ["x", "y\u0000"] } })).toBe(true);
    expect(containsNul([{ reason: "\u0000" }])).toBe(true);
  });

  it("passes text without one, including newlines and tabs", () => {
    expect(containsNul({ body: "line one\n\tline two", n: 3, ok: true, none: null })).toBe(false);
    expect(containsNul(undefined)).toBe(false);
  });

  it("doesn't look inside files or other non-plain values", () => {
    const file = new File([new Uint8Array([0, 0, 0])], "a\u0000.png");
    expect(containsNul({ file })).toBe(false);
  });
});
