import { describe, expect, it } from "bun:test";

import { resolvePoolMax } from "../src/client";

/**
 * Pool-size parsing. Pure, so no database is needed. The failure that matters is
 * a malformed value silently becoming a pool of zero — every query would then
 * wait forever for a connection that is never created.
 */
describe("resolvePoolMax", () => {
  it("prefers an explicit option over the environment", () => {
    expect(resolvePoolMax(5, "20")).toBe(5);
  });

  it("falls back to the environment when no option is given", () => {
    expect(resolvePoolMax(undefined, "20")).toBe(20);
  });

  it("returns undefined (Bun's default) when neither is set", () => {
    expect(resolvePoolMax(undefined, undefined)).toBeUndefined();
    expect(resolvePoolMax(undefined, "")).toBeUndefined();
    expect(resolvePoolMax(undefined, "   ")).toBeUndefined();
  });

  it("rejects zero and negatives rather than capping the pool at nothing", () => {
    expect(resolvePoolMax(undefined, "0")).toBeUndefined();
    expect(resolvePoolMax(undefined, "-1")).toBeUndefined();
    expect(resolvePoolMax(0, undefined)).toBeUndefined();
    expect(resolvePoolMax(-4, undefined)).toBeUndefined();
  });

  it("rejects non-numeric and non-finite values", () => {
    expect(resolvePoolMax(undefined, "lots")).toBeUndefined();
    expect(resolvePoolMax(undefined, "Infinity")).toBeUndefined();
    expect(resolvePoolMax(Number.NaN, undefined)).toBeUndefined();
    expect(resolvePoolMax(Number.POSITIVE_INFINITY, undefined)).toBeUndefined();
  });

  it("an invalid explicit option does NOT fall through to the environment", () => {
    // Explicit intent that is unusable is a caller bug; silently substituting the
    // environment would hide it behind a pool size nobody asked for.
    expect(resolvePoolMax(0, "20")).toBeUndefined();
  });
});
