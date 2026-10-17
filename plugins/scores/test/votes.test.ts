import { describe, expect, it } from "bun:test";

import { toVote, voteDelta, type Vote } from "../src/votes";

describe("toVote", () => {
  it("accepts -1, 0 and 1", () => {
    expect(toVote(-1)).toBe(-1);
    expect(toVote(0)).toBe(0);
    expect(toVote(1)).toBe(1);
  });

  it("rejects anything else", () => {
    for (const n of [2, -2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(toVote(n)).toBeNull();
  });
});

describe("voteDelta", () => {
  it("adds a new vote", () => {
    expect(voteDelta(0, 1)).toEqual({ score: 1, up: 1, down: 0 });
    expect(voteDelta(0, -1)).toEqual({ score: -1, up: 0, down: 1 });
  });

  it("removes a vote", () => {
    expect(voteDelta(1, 0)).toEqual({ score: -1, up: -1, down: 0 });
    expect(voteDelta(-1, 0)).toEqual({ score: 1, up: 0, down: -1 });
  });

  it("flips a vote", () => {
    expect(voteDelta(1, -1)).toEqual({ score: -2, up: -1, down: 1 });
    expect(voteDelta(-1, 1)).toEqual({ score: 2, up: 1, down: -1 });
  });

  it("changes nothing for the same vote", () => {
    for (const v of [-1, 0, 1] as const) expect(voteDelta(v, v)).toEqual({ score: 0, up: 0, down: 0 });
  });

  it("keeps score = up - down along any sequence of votes", () => {
    const sequence: Vote[] = [1, 1, -1, 0, -1, 1, 0, 0, -1];
    let previous: Vote = 0;
    const total = { score: 0, up: 0, down: 0 };
    for (const next of sequence) {
      const d = voteDelta(previous, next);
      total.score += d.score;
      total.up += d.up;
      total.down += d.down;
      previous = next;
      expect(total.score).toBe(total.up - total.down);
      expect(total.score).toBe(next);
    }
  });
});
