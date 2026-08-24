import { describe, expect, it } from "bun:test";

import { parseReviewArgs } from "./cr";

/**
 * Argument handling for `cr review`.
 *
 * The stake is quiet-wrong behaviour rather than a crash: a flag whose value is
 * missing used to fall through to a full `--base main` review, so you got a
 * review — just not the one you asked for — and only noticed by reading the diff
 * header. That is the same failure class the wrapper's usage-detection guard
 * exists to catch.
 */
describe("parseReviewArgs", () => {
  it("defaults to main with no arguments", () => {
    expect(parseReviewArgs([])).toEqual({ base: "main", baseCommit: undefined });
  });

  it("reads an explicit base branch", () => {
    expect(parseReviewArgs(["--base", "develop"])).toEqual({
      base: "develop",
      baseCommit: undefined,
    });
  });

  it("reads a base commit, leaving base at its default", () => {
    expect(parseReviewArgs(["--base-commit", "abc123"])).toEqual({
      base: "main",
      baseCommit: "abc123",
    });
  });

  it("accepts both, since cmdReview prefers the commit", () => {
    expect(parseReviewArgs(["--base", "develop", "--base-commit", "abc123"])).toEqual({
      base: "develop",
      baseCommit: "abc123",
    });
  });

  it("throws when a flag is the final argument", () => {
    expect(() => parseReviewArgs(["--base-commit"])).toThrow(/--base-commit requires a value/);
    expect(() => parseReviewArgs(["--base"])).toThrow(/--base requires a value/);
  });

  it("throws when the next token is another flag, not a value", () => {
    // `--base-commit --base main` reads as a commit named "--base" otherwise.
    expect(() => parseReviewArgs(["--base-commit", "--base", "main"])).toThrow(
      /--base-commit requires a value/,
    );
  });
});
