import type { SearchTerm } from "@bunbooru/plugin-sdk";

/** A comparison operator other than a range. */
export type ScoreCompareOp = "eq" | "gt" | "gte" | "lt" | "lte";

/** A `score:` term, parsed: one comparison, or a (possibly half-open) range. */
export type ScoreFilter =
  | { kind: "compare"; op: ScoreCompareOp; n: number }
  | { kind: "range"; lo: number | undefined; hi: number | undefined };

/** An optionally signed run of digits: the only numbers `score:` accepts. */
const INTEGER_RE = /^[+-]?\d+$/;

/** `raw` as a safe integer, or undefined (a fraction, junk, or out of range). */
function parseInteger(raw: string): number | undefined {
  if (!INTEGER_RE.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Parse a `score:` term with Core's numeric-metatag operators: `score:5`,
 * `score:>10`, `score:>=3`, `score:<0`, `score:<=-2`, and the range `1..10`
 * (either end may be open, `1..` / `..10`). Scores are whole numbers, so a
 * value that isn't an integer is undefined: the term is ignored, as Core
 * ignores a malformed numeric term.
 */
export function parseScoreTerm({ op, value }: SearchTerm): ScoreFilter | undefined {
  if (op !== "range") {
    const n = parseInteger(value.trim());
    return n === undefined ? undefined : { kind: "compare", op, n };
  }
  // Exactly one `..` separates the bounds, as in Core (`1..2..3` is malformed).
  const parts = value.split("..");
  if (parts.length !== 2) return undefined;
  const [loRaw = "", hiRaw = ""] = parts;
  const lo = loRaw ? parseInteger(loRaw) : undefined;
  const hi = hiRaw ? parseInteger(hiRaw) : undefined;
  if ((loRaw && lo === undefined) || (hiRaw && hi === undefined)) return undefined;
  if (lo === undefined && hi === undefined) return undefined;
  return { kind: "range", lo, hi };
}

/** Whether a score of `score` satisfies `filter` (pure; the SQL mirrors it). */
export function scoreMatches(filter: ScoreFilter, score: number): boolean {
  if (filter.kind === "range") {
    return (filter.lo === undefined || score >= filter.lo) && (filter.hi === undefined || score <= filter.hi);
  }
  switch (filter.op) {
    case "eq":
      return score === filter.n;
    case "gt":
      return score > filter.n;
    case "gte":
      return score >= filter.n;
    case "lt":
      return score < filter.n;
    case "lte":
      return score <= filter.n;
  }
}
