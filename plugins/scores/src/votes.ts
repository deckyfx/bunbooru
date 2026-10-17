/** A user's vote on a post: down, none, or up. */
export type Vote = -1 | 0 | 1;

/** How a vote change moves a post's totals. */
export interface TotalsDelta {
  score: number;
  up: number;
  down: number;
}

/** A post's score as the routes return it: totals, plus the caller's own vote. */
export interface ScoreStatus {
  score: number;
  up: number;
  down: number;
  /** The caller's vote; 0 when anonymous or they haven't voted. */
  mine: Vote;
}

/** Narrow a stored or submitted number to a {@link Vote}, or null if it isn't one. */
export function toVote(value: number): Vote | null {
  return value === -1 || value === 0 || value === 1 ? value : null;
}

/**
 * The change to a post's totals when one user's vote goes from `previous` to
 * `next` (0 meaning no vote). Pure, so the totals' bookkeeping is testable
 * without a database: e.g. up → down is `{ score: -2, up: -1, down: +1 }`.
 */
export function voteDelta(previous: Vote, next: Vote): TotalsDelta {
  const up = (next === 1 ? 1 : 0) - (previous === 1 ? 1 : 0);
  const down = (next === -1 ? 1 : 0) - (previous === -1 ? 1 : 0);
  return { score: next - previous, up, down };
}
