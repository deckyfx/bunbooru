import { describe, expect, it } from "bun:test";

import { ValidationError } from "@bunbooru/plugin-sdk";

import { MAX_NOTE, MAX_REASON, normalizeNote, normalizeReason } from "../src/reasons";

describe("normalizeReason", () => {
  it("trims a reason", () => {
    expect(normalizeReason("  spam \n")).toBe("spam");
  });

  it("refuses a blank reason", () => {
    expect(() => normalizeReason("")).toThrow(ValidationError);
    expect(() => normalizeReason(" \t\n ")).toThrow(/why you're reporting/);
  });

  it("bounds the length after trimming", () => {
    expect(normalizeReason(` ${"a".repeat(MAX_REASON)} `)).toHaveLength(MAX_REASON);
    expect(() => normalizeReason("a".repeat(MAX_REASON + 1))).toThrow(/at most 500/);
  });
});

describe("normalizeNote", () => {
  it("treats absent or blank as null, and trims the rest", () => {
    expect(normalizeNote(undefined)).toBeNull();
    expect(normalizeNote("   ")).toBeNull();
    expect(normalizeNote(" not a dupe ")).toBe("not a dupe");
  });

  it("bounds the length", () => {
    expect(() => normalizeNote("a".repeat(MAX_NOTE + 1))).toThrow(ValidationError);
  });
});
