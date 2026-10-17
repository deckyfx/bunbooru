import { describe, expect, it } from "bun:test";

import { ValidationError } from "@bunbooru/plugin-sdk";

import { MAX_BODY, normalizeBody } from "../src/body";

describe("normalizeBody", () => {
  it("trims a note, keeping its inner newlines", () => {
    expect(normalizeBody("  Hello!\n\nWorld \n")).toBe("Hello!\n\nWorld");
  });

  it("refuses a blank note", () => {
    expect(() => normalizeBody("")).toThrow(ValidationError);
    expect(() => normalizeBody(" \t\n ")).toThrow(/can't be blank/);
  });

  it("bounds the length after trimming", () => {
    expect(normalizeBody(` ${"a".repeat(MAX_BODY)} `)).toHaveLength(MAX_BODY);
    expect(() => normalizeBody("a".repeat(MAX_BODY + 1))).toThrow(/at most 1000/);
  });
});
