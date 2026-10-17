import { describe, expect, it } from "bun:test";

import { containsNul } from "../../src/lib/nul";

describe("containsNul", () => {
  it("finds a NUL in a string at any depth of plain data", () => {
    expect(containsNul("a\u0000b")).toBe(true);
    expect(containsNul({ body: "ok", nested: { tags: ["x", "y\u0000"] } })).toBe(true);
    expect(containsNul([{ reason: "\u0000" }])).toBe(true);
  });

  it("checks object keys, not just values", () => {
    expect(containsNul({ "a\u0000b": "ok" })).toBe(true);
    expect(containsNul([{ nested: { "\u0000": 1 } }])).toBe(true);
  });

  it("finds a NUL however deep it is nested", () => {
    let deep: unknown = { leaf: "x\u0000" };
    for (let i = 0; i < 1000; i++) deep = { next: [deep] };
    expect(containsNul(deep)).toBe(true);
    let clean: unknown = { leaf: "x" };
    for (let i = 0; i < 1000; i++) clean = { next: [clean] };
    expect(containsNul(clean)).toBe(false);
  });

  it("handles a very large array", () => {
    const big = Array.from({ length: 500_000 }, (_, i) => `t${i}`);
    expect(containsNul({ tags: big })).toBe(false);
    big[499_999] = "\u0000";
    expect(containsNul({ tags: big })).toBe(true);
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
