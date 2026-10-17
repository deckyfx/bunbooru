import { useRef, type PointerEvent } from "react";

import { moveBox, resizeBox, type Corner } from "./adjust";
import type { Box } from "./client";

/** What a handle drags: the whole box, or one corner of it. */
export type DragKind = "move" | Corner;

/** A drag in progress: where it started, in client pixels, over which layer box. */
interface DragState {
  pointerId: number;
  kind: DragKind;
  startX: number;
  startY: number;
  rect: DOMRect;
  startBox: Box;
}

/** The pointer handlers one drag handle spreads onto its element. */
export interface DragHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
}

/**
 * Pointer dragging for an adjusted note's handles, the way DrawSurface draws:
 * pointer events (mouse, pen and touch alike), captured on the handle so a drag
 * that leaves the image still ends cleanly. The pointer's travel is converted
 * to fractions of `layer()`'s box (the displayed image) and applied to the box
 * the drag started from, so every move previews a clamped box via `onChange`.
 * A cancelled drag (the browser took the gesture) snaps back to where it began.
 */
export function useBoxDrag({
  box,
  onChange,
  layer,
  disabled,
}: {
  box: Box;
  onChange: (box: Box) => void;
  layer: () => HTMLElement | null;
  disabled: boolean;
}): (kind: DragKind) => DragHandlers {
  const drag = useRef<DragState | null>(null);

  /** The box `drag` has reached with the pointer at `e`. */
  const boxAt = (state: DragState, e: PointerEvent<HTMLElement>): Box => {
    const dx = state.rect.width > 0 ? (e.clientX - state.startX) / state.rect.width : 0;
    const dy = state.rect.height > 0 ? (e.clientY - state.startY) / state.rect.height : 0;
    return state.kind === "move" ? moveBox(state.startBox, dx, dy) : resizeBox(state.startBox, state.kind, dx, dy);
  };

  return (kind) => ({
    onPointerDown: (e) => {
      if (disabled || e.button !== 0 || drag.current) return;
      const rect = layer()?.getBoundingClientRect();
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { pointerId: e.pointerId, kind, startX: e.clientX, startY: e.clientY, rect, startBox: box };
    },
    onPointerMove: (e) => {
      const state = drag.current;
      if (state?.pointerId === e.pointerId) onChange(boxAt(state, e));
    },
    onPointerUp: (e) => {
      const state = drag.current;
      if (state?.pointerId !== e.pointerId) return;
      drag.current = null;
      onChange(boxAt(state, e));
    },
    onPointerCancel: (e) => {
      const state = drag.current;
      if (state?.pointerId !== e.pointerId) return;
      drag.current = null;
      onChange(state.startBox);
    },
  });
}
