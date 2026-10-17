import { describe, expect, it } from "bun:test";

import { ValidationError } from "@bunbooru/plugin-sdk";

import { displayTitle, MAX_TITLE, parseTitle, plainSearchTag } from "../src/title";
import { MAX_BODY, normalizeBody, requireTitle } from "../src/validate";

describe("parseTitle", () => {
  it("normalizes like a tag name: trimmed, lowercased, whitespace runs to one underscore", () => {
    expect(parseTitle("  Blue   Sky\t\nAt Night ")).toEqual({ ok: true, title: "blue_sky_at_night" });
  });

  it("keeps characters a tag name may hold", () => {
    for (const title of ["ac/dc", "what?", "50%", ":)", "c++", "über", "rating:safe", "a#b&c"]) {
      expect(parseTitle(title)).toEqual({ ok: true, title });
    }
  });

  it("bounds the length after normalization", () => {
    expect(parseTitle(` ${"a".repeat(MAX_TITLE)} `)).toEqual({ ok: true, title: "a".repeat(MAX_TITLE) });
    expect(parseTitle("a".repeat(MAX_TITLE + 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 100/) });
  });

  it("refuses blank, wildcard, control-character and dot-segment titles", () => {
    for (const raw of ["", "   \n\t", "blue*", "a\u0000b", "a\u007fb", ".", ".."]) {
      expect(parseTitle(raw).ok).toBe(false);
    }
    expect(parseTitle("...").ok).toBe(true);
  });
});

describe("requireTitle", () => {
  it("returns the title or throws a ValidationError with the reason", () => {
    expect(requireTitle("Blue Sky")).toBe("blue_sky");
    expect(() => requireTitle(" ")).toThrow(ValidationError);
    expect(() => requireTitle("a*")).toThrow(/can't contain "\*"/);
  });
});

describe("plainSearchTag", () => {
  it("is the title of a single plain tag", () => {
    expect(plainSearchTag("blue_sky")).toBe("blue_sky");
    expect(plainSearchTag("  Blue_Sky ")).toBe("blue_sky");
    expect(plainSearchTag(":)")).toBe(":)"); // a colon first is a tag, not a metatag
  });

  it("is null for an empty or complex query", () => {
    for (const query of ["", "   ", "a b", "-a", "~a", "rating:safe", "order:score", "blue*", "*"]) {
      expect(plainSearchTag(query)).toBeNull();
    }
  });
});

describe("displayTitle", () => {
  it("shows underscores as spaces", () => {
    expect(displayTitle("blue_sky")).toBe("blue sky");
  });
});

describe("normalizeBody", () => {
  it("trims, keeping inner newlines", () => {
    expect(normalizeBody("\n  one\n\ntwo  \n")).toBe("one\n\ntwo");
  });

  it("refuses a blank or overlong body", () => {
    expect(() => normalizeBody(" \n ")).toThrow(/can't be blank/);
    expect(normalizeBody(` ${"a".repeat(MAX_BODY)} `)).toHaveLength(MAX_BODY);
    expect(() => normalizeBody("a".repeat(MAX_BODY + 1))).toThrow(/at most 20000/);
  });
});
