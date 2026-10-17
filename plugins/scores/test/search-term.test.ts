import { describe, expect, it } from "bun:test";

import { parseScoreTerm, scoreMatches, type ScoreFilter } from "../src/search-term";

describe("parseScoreTerm", () => {
  it("parses each comparison", () => {
    expect(parseScoreTerm({ op: "eq", value: "5" })).toEqual({ kind: "compare", op: "eq", n: 5 });
    expect(parseScoreTerm({ op: "gt", value: "10" })).toEqual({ kind: "compare", op: "gt", n: 10 });
    expect(parseScoreTerm({ op: "gte", value: "3" })).toEqual({ kind: "compare", op: "gte", n: 3 });
    expect(parseScoreTerm({ op: "lt", value: "0" })).toEqual({ kind: "compare", op: "lt", n: 0 });
    expect(parseScoreTerm({ op: "lte", value: "-2" })).toEqual({ kind: "compare", op: "lte", n: -2 });
    expect(parseScoreTerm({ op: "eq", value: "+4" })).toEqual({ kind: "compare", op: "eq", n: 4 });
  });

  it("parses closed and half-open ranges, including negative bounds", () => {
    expect(parseScoreTerm({ op: "range", value: "1..10" })).toEqual({ kind: "range", lo: 1, hi: 10 });
    expect(parseScoreTerm({ op: "range", value: "-5..5" })).toEqual({ kind: "range", lo: -5, hi: 5 });
    expect(parseScoreTerm({ op: "range", value: "3.." })).toEqual({ kind: "range", lo: 3, hi: undefined });
    expect(parseScoreTerm({ op: "range", value: "..-1" })).toEqual({ kind: "range", lo: undefined, hi: -1 });
  });

  it("ignores values that aren't integers", () => {
    for (const value of ["", "1.5", "abc", "1e3", "0x10", "9007199254740993", " "]) {
      expect(parseScoreTerm({ op: "eq", value })).toBeUndefined();
    }
  });

  it("ignores malformed ranges", () => {
    for (const value of ["..", "1..2..3", "a..2", "1..b", "1.5..2"]) {
      expect(parseScoreTerm({ op: "range", value })).toBeUndefined();
    }
  });
});

describe("scoreMatches", () => {
  const compare = (op: "eq" | "gt" | "gte" | "lt" | "lte", n: number): ScoreFilter => ({ kind: "compare", op, n });

  it("evaluates comparisons", () => {
    expect(scoreMatches(compare("eq", 0), 0)).toBe(true);
    expect(scoreMatches(compare("gt", 0), 0)).toBe(false);
    expect(scoreMatches(compare("gte", 0), 0)).toBe(true);
    expect(scoreMatches(compare("lt", 0), -1)).toBe(true);
    expect(scoreMatches(compare("lte", -1), 0)).toBe(false);
  });

  it("evaluates ranges inclusively, with open ends", () => {
    expect(scoreMatches({ kind: "range", lo: 1, hi: 10 }, 1)).toBe(true);
    expect(scoreMatches({ kind: "range", lo: 1, hi: 10 }, 10)).toBe(true);
    expect(scoreMatches({ kind: "range", lo: 1, hi: 10 }, 0)).toBe(false);
    expect(scoreMatches({ kind: "range", lo: undefined, hi: 0 }, -100)).toBe(true);
    expect(scoreMatches({ kind: "range", lo: 1, hi: undefined }, 0)).toBe(false);
  });
});
