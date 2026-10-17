import type { CSSProperties } from "react";

import type { Box } from "./client";

/** Smallest side the server accepts, as a fraction of the image (it refuses anything smaller). */
export const MIN_SIZE = 0.005;

/** A point in fractions of the layer. */
export interface Point {
  x: number;
  y: number;
}

/** `value` clamped to 0..1. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A client-space pointer position as a fraction of `rect` (the layer's box), clamped to it. */
export function toFraction(clientX: number, clientY: number, rect: DOMRect): Point {
  return {
    x: rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : 0,
    y: rect.height > 0 ? clamp01((clientY - rect.top) / rect.height) : 0,
  };
}

/** The box spanned by two corners, dragged in any direction. */
export function boxFromPoints(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Whether `box` is big enough to save. */
export function isUsable(box: Box): boolean {
  return box.w >= MIN_SIZE && box.h >= MIN_SIZE;
}

/** Absolute-positioning style placing `box` in its layer, in percentages (the image is scaled). */
export function boxStyle(box: Box): CSSProperties {
  return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` };
}

/**
 * Classes placing a popover beside `box`: below it unless it sits low,
 * right-aligned when it sits right. The gap is padding, not margin, so the
 * pointer crossing it stays inside the note (no flicker on the way over).
 */
export function popoverPlacement(box: Box): string {
  const vertical = box.y + box.h > 0.7 ? "bottom-full pb-1" : "top-full pt-1";
  const horizontal = box.x + box.w / 2 > 0.5 ? "right-0" : "left-0";
  return `${vertical} ${horizontal}`;
}

/** The first few words of a note, for its accessible label. */
export function excerpt(body: string, words = 6): string {
  const parts = body.split(/\s+/).filter(Boolean);
  const head = parts.slice(0, words).join(" ");
  return parts.length > words ? `${head}…` : head;
}
