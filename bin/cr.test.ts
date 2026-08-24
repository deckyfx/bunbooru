import { describe, expect, it } from "bun:test";

import { classifyReviewOutcome, parseReviewArgs } from "./cr";

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

  it("rejects a misspelled flag instead of ignoring it", () => {
    // The whole point: an ignored `--base-comit` would fall through to a full
    // `--base main` review and look like it worked.
    expect(() => parseReviewArgs(["--base-comit", "abc123"])).toThrow(/unknown option/);
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseReviewArgs(["main"])).toThrow(/unexpected argument "main"/);
    expect(() => parseReviewArgs(["--base", "develop", "extra"])).toThrow(/unexpected argument/);
  });

  it("rejects a repeated flag rather than silently taking the first", () => {
    expect(() => parseReviewArgs(["--base", "a", "--base", "b"])).toThrow(/more than once/);
    expect(() => parseReviewArgs(["--base-commit", "a", "--base-commit", "b"])).toThrow(
      /more than once/,
    );
  });

  it("rejects a repeated flag that is missing its value", () => {
    // indexOf-based parsing found the FIRST occurrence and never looked at the
    // trailing bare flag at all.
    expect(() => parseReviewArgs(["--base", "a", "--base-commit"])).toThrow(
      /--base-commit requires a value/,
    );
  });
});

/**
 * Outcome classification. The trap is that the CLI echoes finding text into the
 * same stream it reports its own status on, so any loose keyword search can be
 * tripped by a review that merely DISCUSSES rate limiting.
 */
describe("classifyReviewOutcome", () => {
  /** Real output from an exhausted quota. */
  const RATE_LIMITED = [
    "Connecting to CodeRabbit... 1s elapsed",
    "",
    "  ✗ Review limit reached",
    "",
    "  Limit details: You've used all 3 included reviews currently available.",
    "  You can wait 21 minutes for the limit to reset.",
    "Error: Rate limit exceeded",
  ].join("\n");

  it("detects a genuine rate limit", () => {
    expect(classifyReviewOutcome(RATE_LIMITED, 1)).toBe("rate-limited");
  });

  it("does NOT mistake a finding that discusses rate limiting for one", () => {
    // This exact situation arose: a review of this very file quoted the phrase,
    // and only the CLI's line wrapping stopped a loose regex from matching.
    const reviewMentioningIt = [
      "  minor [Functional Correctness]",
      "  → bin/cr.ts:293-296",
      "  Use an unambiguous rate-limit response.",
      "  A successful review can contain rate limit in a finding or quoted line.",
      "Review complete",
      "1 finding ✔",
    ].join("\n");
    expect(classifyReviewOutcome(reviewMentioningIt, 0)).toBe("reviewed");
  });

  it("detects rejected arguments", () => {
    expect(classifyReviewOutcome("error: unknown option '--plain'\n", 0)).toBe("rejected-args");
    expect(classifyReviewOutcome("Usage: coderabbit review [options]\n", 0)).toBe("rejected-args");
  });

  it("treats findings as a completed review, not a failure", () => {
    // Verified against a real run: 5 findings, exit 0.
    expect(classifyReviewOutcome("Review complete\n5 findings ✔\nMajor    3\n", 0)).toBe(
      "reviewed",
    );
  });

  it("reports any other non-zero exit as a failure", () => {
    expect(classifyReviewOutcome("Connecting to CodeRabbit...\n", 1)).toBe("failed");
  });

  it("trusts the completion banner over echoed marker text", () => {
    // A review whose FINDINGS quote the CLI's own error strings must still be
    // classified as completed — otherwise reviewing this very file reports that
    // no review ran. The positive marker is checked first for exactly this reason.
    const quotesEverything = [
      "  major [Functional Correctness]",
      "  → bin/cr.ts:275",
      "  The guard matches error: unknown option anywhere in the stream.",
      "Error: Rate limit exceeded",
      "  ✗ Review limit reached",
      "Review complete",
      "2 findings ✔",
    ].join("\n");
    expect(classifyReviewOutcome(quotesEverything, 0)).toBe("reviewed");
  });

  it("does not let a leading blank line span into a later line", () => {
    // `^\s*` would match here because \s consumes newlines; `[ \t]*` does not.
    expect(classifyReviewOutcome("\n\nsomething else Review limit reached now\n", 1)).toBe(
      "failed",
    );
  });

  it("does not call an unrecognised zero-exit run a success", () => {
    // "Assume it worked" is precisely the failure this classifier exists to remove.
    expect(classifyReviewOutcome("", 0)).toBe("failed");
    expect(classifyReviewOutcome("Connecting to CodeRabbit... 1s elapsed\n", 0)).toBe("failed");
  });

  it("distrusts a completion banner contradicted by a non-zero exit", () => {
    // Findings alone exit 0, so a banner plus a failure code is a disagreement
    // rather than a normal outcome — don't guess which half to believe.
    expect(classifyReviewOutcome("Review complete\n1 finding ✔\n", 1)).toBe("failed");
  });

  it("treats an empty range as a completed run, not a failure", () => {
    const nothing = [
      "Diff      : committed changes only",
      "No committed changes detected 🔎",
      "Nothing to review.",
    ].join("\n");
    expect(classifyReviewOutcome(nothing, 0)).toBe("reviewed");
  });
});
