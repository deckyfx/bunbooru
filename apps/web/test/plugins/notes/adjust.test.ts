import { describe, expect, it } from "bun:test";

import {
  clampBox,
  KEY_STEP,
  moveBox,
  nudgeBox,
  resizeBox,
  sameBox,
  toSavable,
} from "../../../src/plugins/notes/adjust";
import type { Box } from "../../../src/plugins/notes/client";
import { MIN_SIZE } from "../../../src/plugins/notes/geometry";

const BOX: Box = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };

/** Assert `box` is on the image and at least the minimum size on each side. */
function expectValid(box: Box) {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(box.y + box.h).toBeLessThanOrEqual(1 + 1e-9);
  expect(box.w).toBeGreaterThanOrEqual(MIN_SIZE - 1e-12);
  expect(box.h).toBeGreaterThanOrEqual(MIN_SIZE - 1e-12);
}

/** Field-by-field closeness (float sums aren't exact). */
function expectClose(actual: Box, expected: Box) {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.w).toBeCloseTo(expected.w, 9);
  expect(actual.h).toBeCloseTo(expected.h, 9);
}

describe("moveBox", () => {
  it("shifts the box and keeps its size", () => {
    expectClose(moveBox(BOX, 0.1, -0.1), { x: 0.3, y: 0.2, w: 0.4, h: 0.2 });
  });

  it("stops at every edge, size unchanged", () => {
    expectClose(moveBox(BOX, -5, -5), { x: 0, y: 0, w: 0.4, h: 0.2 });
    expectClose(moveBox(BOX, 5, 5), { x: 0.6, y: 0.8, w: 0.4, h: 0.2 });
  });

  it("keeps a full-image box where it is", () => {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    expect(moveBox(full, 0.3, -0.3)).toEqual(full);
  });
});

describe("resizeBox", () => {
  it("drags the south-east corner, top-left fixed", () => {
    expectClose(resizeBox(BOX, "se", 0.1, 0.1), { x: 0.2, y: 0.3, w: 0.5, h: 0.3 });
  });

  it("drags the north-west corner, bottom-right fixed", () => {
    expectClose(resizeBox(BOX, "nw", -0.1, -0.1), { x: 0.1, y: 0.2, w: 0.5, h: 0.3 });
  });

  it("drags the north-east and south-west corners", () => {
    expectClose(resizeBox(BOX, "ne", 0.1, -0.1), { x: 0.2, y: 0.2, w: 0.5, h: 0.3 });
    expectClose(resizeBox(BOX, "sw", -0.1, 0.1), { x: 0.1, y: 0.3, w: 0.5, h: 0.3 });
  });

  it("stops at the image's edges", () => {
    expectClose(resizeBox(BOX, "se", 5, 5), { x: 0.2, y: 0.3, w: 0.8, h: 0.7 });
    expectClose(resizeBox(BOX, "nw", -5, -5), { x: 0, y: 0, w: 0.6, h: 0.5 });
  });

  it("never shrinks below the minimum size, even dragged past the opposite corner", () => {
    const se = resizeBox(BOX, "se", -5, -5);
    expectClose(se, { x: 0.2, y: 0.3, w: MIN_SIZE, h: MIN_SIZE });
    const nw = resizeBox(BOX, "nw", 5, 5);
    expectClose(nw, { x: 0.6 - MIN_SIZE, y: 0.5 - MIN_SIZE, w: MIN_SIZE, h: MIN_SIZE });
  });

  it("honours a custom minimum size", () => {
    expectClose(resizeBox(BOX, "se", -1, -1, 0.1), { x: 0.2, y: 0.3, w: 0.1, h: 0.1 });
  });

  it("always yields a valid box", () => {
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      for (const [dx, dy] of [
        [-2, -2],
        [2, 2],
        [-2, 2],
        [2, -2],
        [0.05, -0.05],
      ] as const) {
        expectValid(resizeBox(BOX, corner, dx, dy));
      }
    }
  });
});

describe("clampBox", () => {
  it("keeps a box that's already on the image", () => {
    expect(clampBox(BOX)).toEqual(BOX);
  });

  it("pulls a box hanging off the image back on, keeping its size", () => {
    expectClose(clampBox({ x: 0.9, y: -0.1, w: 0.3, h: 0.2 }), { x: 0.7, y: 0, w: 0.3, h: 0.2 });
  });

  it("grows a too-small box and shrinks a too-big one", () => {
    expect(clampBox({ x: 0.5, y: 0.5, w: 0, h: 0.001 })).toEqual({ x: 0.5, y: 0.5, w: MIN_SIZE, h: MIN_SIZE });
    expect(clampBox({ x: -1, y: -1, w: 3, h: 2 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("nudgeBox", () => {
  it("moves by one step with the arrows", () => {
    expectClose(nudgeBox(BOX, "ArrowRight", false)!, { ...BOX, x: BOX.x + KEY_STEP });
    expectClose(nudgeBox(BOX, "ArrowLeft", false)!, { ...BOX, x: BOX.x - KEY_STEP });
    expectClose(nudgeBox(BOX, "ArrowDown", false)!, { ...BOX, y: BOX.y + KEY_STEP });
    expectClose(nudgeBox(BOX, "ArrowUp", false)!, { ...BOX, y: BOX.y - KEY_STEP });
  });

  it("resizes from the bottom-right with Shift+arrows", () => {
    expectClose(nudgeBox(BOX, "ArrowRight", true)!, { ...BOX, w: BOX.w + KEY_STEP });
    expectClose(nudgeBox(BOX, "ArrowLeft", true)!, { ...BOX, w: BOX.w - KEY_STEP });
    expectClose(nudgeBox(BOX, "ArrowDown", true)!, { ...BOX, h: BOX.h + KEY_STEP });
    expectClose(nudgeBox(BOX, "ArrowUp", true)!, { ...BOX, h: BOX.h - KEY_STEP });
  });

  it("clamps at the edges and the minimum size", () => {
    const corner = { x: 0, y: 0, w: MIN_SIZE, h: MIN_SIZE };
    expect(nudgeBox(corner, "ArrowLeft", false)).toEqual(corner);
    expect(nudgeBox(corner, "ArrowUp", true)).toEqual(corner);
  });

  it("ignores other keys", () => {
    expect(nudgeBox(BOX, "a", false)).toBeNull();
    expect(nudgeBox(BOX, "Enter", true)).toBeNull();
  });
});

describe("sameBox", () => {
  it("compares every field", () => {
    expect(sameBox(BOX, { ...BOX })).toBe(true);
    expect(sameBox(BOX, { ...BOX, h: 0.21 })).toBe(false);
  });
});

describe("toSavable", () => {
  it("strips float noise from keyboard steps onto the 6-decimal grid", () => {
    let box: Box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    for (let i = 0; i < 7; i++) box = nudgeBox(box, "ArrowRight", false)!;
    expect(toSavable(box)).toEqual({ x: 0.17, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("keeps a minimum-size box at least the minimum after rounding", () => {
    const tiny = { x: 0.1234567, y: 0.7654321, w: MIN_SIZE, h: MIN_SIZE };
    const saved = toSavable(tiny);
    // The server's own rule: edges rounded, width = rounded right minus left.
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    expect(round(round(saved.x + saved.w) - saved.x)).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(round(round(saved.y + saved.h) - saved.y)).toBeGreaterThanOrEqual(MIN_SIZE);
    expectValid(saved);
  });

  it("keeps a box flush with the far edges on the image", () => {
    const saved = toSavable(moveBox({ x: 0.3, y: 0.3, w: 0.33, h: 0.17 }, 5, 5));
    expectValid(saved);
    expect(saved.x + saved.w).toBeCloseTo(1, 9);
    expect(saved.y + saved.h).toBeCloseTo(1, 9);
  });
});
