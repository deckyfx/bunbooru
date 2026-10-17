import { ValidationError } from "@bunbooru/plugin-sdk";

/**
 * A note's box over a post's image, in FRACTIONS of the image (0..1): `x`/`y`
 * is the top-left corner, `w`/`h` the size. Fractions survive any display size.
 */
export interface NoteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest width or height a note may have, as a fraction of the image. */
export const MIN_SIZE = 0.005;

/** Decimal places kept: a millionth of the image is sub-pixel even for 100k-px images. */
const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;

/** `value` rounded to {@link DECIMALS} places. */
function round(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

/** `value` clamped to 0..1. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Validate and normalize a box: every field a finite number, a positive size,
 * the edges clamped to the image, then rounded. A box that ends up smaller than
 * {@link MIN_SIZE} on either side (tiny, or mostly outside the image) is
 * refused. Throws ValidationError.
 *
 * Edges are clamped and rounded rather than the size, so `x + w` and `y + h`
 * never pass 1 by more than float noise (the table's CHECKs allow 1e-9).
 */
export function normalizeBox(box: NoteBox): NoteBox {
  const { x, y, w, h } = box;
  if (![x, y, w, h].every(Number.isFinite)) throw new ValidationError("A note's box must be finite numbers");
  if (w <= 0 || h <= 0) throw new ValidationError("A note needs a positive width and height");

  const left = round(clamp01(x));
  const top = round(clamp01(y));
  const width = round(round(clamp01(x + w)) - left);
  const height = round(round(clamp01(y + h)) - top);
  if (width < MIN_SIZE || height < MIN_SIZE) {
    throw new ValidationError("A note must be at least 0.5% of the image on each side, and on the image");
  }
  return { x: left, y: top, w: width, h: height };
}
