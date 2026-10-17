import type { Box } from "./client";
import { MIN_SIZE } from "./geometry";

/**
 * Pure box math for moving and resizing a note, all in fractions of the image
 * (0..1). Every function returns a box that lies wholly on the image and is at
 * least `minSize` on each side, so the UI can never preview (or send) a box
 * the server would refuse.
 */

/** A box corner a resize handle drags: north-west, north-east, south-west, south-east. */
export type Corner = "nw" | "ne" | "sw" | "se";

/** Every corner, in reading order (for rendering one handle each). */
export const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

/** How far one arrow-key press moves or resizes a note: 1% of the image. */
export const KEY_STEP = 0.01;

/** Decimal places the server keeps; the client rounds to the same grid before saving. */
const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;

/** `value` clamped to `min..max`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `value` rounded to the server's grid. */
function round(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

/**
 * `box` forced onto the image: its size clamped to `minSize..1`, then its
 * position clamped so the whole box fits inside 0..1.
 */
export function clampBox(box: Box, minSize = MIN_SIZE): Box {
  const w = clamp(box.w, minSize, 1);
  const h = clamp(box.h, minSize, 1);
  return { x: clamp(box.x, 0, 1 - w), y: clamp(box.y, 0, 1 - h), w, h };
}

/** `box` shifted by `dx`/`dy`, keeping its size and stopping at the image's edges. */
export function moveBox(box: Box, dx: number, dy: number): Box {
  return {
    x: clamp(box.x + dx, 0, 1 - box.w),
    y: clamp(box.y + dy, 0, 1 - box.h),
    w: box.w,
    h: box.h,
  };
}

/**
 * `box` resized by dragging `corner` by `dx`/`dy`. The opposite corner stays
 * put; the dragged edges stop at the image's edges and never come closer than
 * `minSize` to the fixed ones (a corner can't be dragged past its opposite).
 */
export function resizeBox(box: Box, corner: Corner, dx: number, dy: number, minSize = MIN_SIZE): Box {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;

  if (corner === "nw" || corner === "sw") left = clamp(left + dx, 0, right - minSize);
  else right = clamp(right + dx, left + minSize, 1);
  if (corner === "nw" || corner === "ne") top = clamp(top + dy, 0, bottom - minSize);
  else bottom = clamp(bottom + dy, top + minSize, 1);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The box after one arrow-key press while adjusting: an arrow moves it by
 * `step`; Shift+arrow resizes it from the bottom-right corner (Right/Down grow
 * it, Left/Up shrink it). Any other key returns null.
 */
export function nudgeBox(box: Box, key: string, shift: boolean, step = KEY_STEP): Box | null {
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const d = delta[key];
  if (!d) return null;
  return shift ? resizeBox(box, "se", d[0], d[1]) : moveBox(box, d[0], d[1]);
}

/** Whether two boxes are the same position and size. */
export function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * `box` snapped to the server's 6-decimal grid by its edges (as the server
 * does), widening a side that rounding pushed under `minSize`, so the PATCH is
 * accepted as sent. Keyboard steps accumulate float noise; this removes it.
 */
export function toSavable(box: Box, minSize = MIN_SIZE): Box {
  const c = clampBox(box, minSize);
  let left = round(c.x);
  let top = round(c.y);
  let right = round(c.x + c.w);
  let bottom = round(c.y + c.h);
  if (right - left < minSize) {
    right = round(Math.min(1, left + minSize));
    left = round(right - minSize);
  }
  if (bottom - top < minSize) {
    bottom = round(Math.min(1, top + minSize));
    top = round(bottom - minSize);
  }
  return { x: left, y: top, w: round(right - left), h: round(bottom - top) };
}
