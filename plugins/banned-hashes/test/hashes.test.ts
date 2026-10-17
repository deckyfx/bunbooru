import { describe, expect, it } from "bun:test";

import { ValidationError } from "@bunbooru/plugin-sdk";

import { normalizeHashes, refusalReason } from "../src/hashes";

const SHA = "AB".repeat(32);
const MD5 = "cd".repeat(16);

describe("normalizeHashes", () => {
  it("lowercases and trims well-formed hashes, either alone or both", () => {
    expect(normalizeHashes({ sha256: ` ${SHA} ` })).toEqual({ sha256: SHA.toLowerCase(), md5: null });
    expect(normalizeHashes({ md5: MD5 })).toEqual({ sha256: null, md5: MD5 });
    expect(normalizeHashes({ sha256: SHA, md5: MD5 })).toEqual({ sha256: SHA.toLowerCase(), md5: MD5 });
  });

  it("treats blanks as absent, and needs at least one hash", () => {
    expect(() => normalizeHashes({ sha256: "  ", md5: "" })).toThrow(ValidationError);
    expect(() => normalizeHashes({})).toThrow(/sha256, an md5, or a post/);
  });

  it("rejects malformed hashes", () => {
    expect(() => normalizeHashes({ sha256: "abc" })).toThrow(/64 hex/);
    expect(() => normalizeHashes({ sha256: "g".repeat(64) })).toThrow(/64 hex/);
    expect(() => normalizeHashes({ md5: SHA })).toThrow(/32 hex/);
  });
});

describe("refusalReason", () => {
  it("includes the moderator's reason when there is one", () => {
    expect(refusalReason("  spam ")).toBe("This file is banned: spam");
    expect(refusalReason("")).toBe("This file is banned");
  });
});
