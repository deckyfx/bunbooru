import { describe, expect, it } from "bun:test";

import {
  backoffDelayMs,
  BASE_BACKOFF_MS,
  isExhausted,
  MAX_BACKOFF_MS,
  MAX_SEND_ATTEMPTS,
  nextAttemptAt,
} from "../src/backoff";

describe("backoffDelayMs", () => {
  it("fires the first send immediately (no prior failures)", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-1)).toBe(0);
  });

  it("grows exponentially from the base delay", () => {
    expect(backoffDelayMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelayMs(3)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffDelayMs(4)).toBe(BASE_BACKOFF_MS * 8);
  });

  it("clamps to the ceiling and never overflows for large attempt counts", () => {
    expect(backoffDelayMs(100)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelayMs(1000)).toBe(MAX_BACKOFF_MS);
  });
});

describe("nextAttemptAt", () => {
  it("offsets from the given clock by the backoff delay", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(nextAttemptAt(1, now).getTime()).toBe(now.getTime() + BASE_BACKOFF_MS);
    expect(nextAttemptAt(0, now).getTime()).toBe(now.getTime());
  });
});

describe("isExhausted (bounded retry budget)", () => {
  it("is false while attempts remain under the budget", () => {
    expect(isExhausted(0)).toBe(false);
    expect(isExhausted(MAX_SEND_ATTEMPTS - 1)).toBe(false);
  });

  it("is true once the budget is reached", () => {
    expect(isExhausted(MAX_SEND_ATTEMPTS)).toBe(true);
    expect(isExhausted(MAX_SEND_ATTEMPTS + 1)).toBe(true);
  });
});
