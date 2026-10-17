import { describe, expect, it } from "bun:test";

import { ValidationError } from "@bunbooru/plugin-sdk";

import { MIN_SIZE, normalizeBox } from "../src/geometry";

describe("normalizeBox", () => {
  it("keeps a box that's already on the image", () => {
    expect(normalizeBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(normalizeBox({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("refuses NaN and infinities", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => normalizeBox({ x: bad, y: 0, w: 0.1, h: 0.1 })).toThrow(ValidationError);
      expect(() => normalizeBox({ x: 0, y: bad, w: 0.1, h: 0.1 })).toThrow(/finite/);
      expect(() => normalizeBox({ x: 0, y: 0, w: bad, h: 0.1 })).toThrow(/finite/);
      expect(() => normalizeBox({ x: 0, y: 0, w: 0.1, h: bad })).toThrow(/finite/);
    }
  });

  it("refuses a zero or negative size", () => {
    expect(() => normalizeBox({ x: 0.5, y: 0.5, w: 0, h: 0.1 })).toThrow(/positive width and height/);
    expect(() => normalizeBox({ x: 0.5, y: 0.5, w: 0.1, h: -0.2 })).toThrow(ValidationError);
  });

  it("clamps a box hanging off the image to its edges", () => {
    expect(normalizeBox({ x: -0.1, y: -0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
    expect(normalizeBox({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 });
  });

  it("refuses a box entirely off the image", () => {
    expect(() => normalizeBox({ x: 1.5, y: 0.1, w: 0.2, h: 0.2 })).toThrow(/on the image/);
    expect(() => normalizeBox({ x: 0.1, y: -2, w: 0.2, h: 0.5 })).toThrow(ValidationError);
  });

  it("refuses boxes smaller than the minimum, before or after clamping", () => {
    expect(() => normalizeBox({ x: 0.5, y: 0.5, w: MIN_SIZE / 2, h: 0.1 })).toThrow(/at least 0.5%/);
    expect(() => normalizeBox({ x: 0.5, y: 0.5, w: 0.1, h: 0.001 })).toThrow(ValidationError);
    // Mostly off the right edge: only a sliver is left on the image.
    expect(() => normalizeBox({ x: 0.998, y: 0.5, w: 0.3, h: 0.1 })).toThrow(ValidationError);
    expect(normalizeBox({ x: 0.5, y: 0.5, w: MIN_SIZE, h: MIN_SIZE })).toEqual({
      x: 0.5,
      y: 0.5,
      w: MIN_SIZE,
      h: MIN_SIZE,
    });
  });

  it("rounds to six decimals, never letting the far edge pass the image", () => {
    const box = normalizeBox({ x: 0.123456789, y: 1 / 3, w: 0.876543211, h: 2 / 3 });
    expect(box).toEqual({ x: 0.123457, y: 0.333333, w: 0.876543, h: 0.666667 });
    expect(box.x + box.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(box.y + box.h).toBeLessThanOrEqual(1 + 1e-9);
  });
});
