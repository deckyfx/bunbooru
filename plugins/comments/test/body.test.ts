import { describe, expect, it } from "bun:test";

import { ValidationError } from "@bunbooru/plugin-sdk";

import { isEdited, MAX_BODY, normalizeBody } from "../src/body";

describe("normalizeBody", () => {
  it("trims a comment, keeping its inner newlines", () => {
    expect(normalizeBody("  nice\n\npic \n")).toBe("nice\n\npic");
  });

  it("refuses a blank comment", () => {
    expect(() => normalizeBody("")).toThrow(ValidationError);
    expect(() => normalizeBody(" \t\n ")).toThrow(/can't be blank/);
  });

  it("bounds the length after trimming", () => {
    expect(normalizeBody(` ${"a".repeat(MAX_BODY)} `)).toHaveLength(MAX_BODY);
    expect(() => normalizeBody("a".repeat(MAX_BODY + 1))).toThrow(/at most 2000/);
  });
});

describe("isEdited", () => {
  const posted = new Date("2026-01-01T00:00:00.000Z");

  it("is false until updatedAt moves past createdAt", () => {
    expect(isEdited({ createdAt: posted, updatedAt: new Date(posted) })).toBe(false);
    expect(isEdited({ createdAt: posted, updatedAt: new Date(posted.getTime() + 1) })).toBe(true);
  });
});
