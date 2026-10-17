import { useRef, useState, type PointerEvent } from "react";

import type { Box } from "./client";
import { boxFromPoints, boxStyle, isUsable, toFraction, type Point } from "./geometry";

/**
 * Draw mode: an interactive layer over the whole image where dragging a
 * rectangle places a new note. Pointer events (mouse, pen and touch alike),
 * captured so a drag that leaves the image still ends cleanly; `touch-none`
 * stops a finger drag from scrolling the page. The drag is converted to
 * fractions of this layer's box, which is the displayed image. A click or a
 * box too small to save is ignored, leaving draw mode on.
 */
export function DrawSurface({ onDrawn }: { onDrawn: (box: Box) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ start: Point; end: Point } | null>(null);

  const pointAt = (e: PointerEvent<HTMLDivElement>): Point | null => {
    const rect = ref.current?.getBoundingClientRect();
    return rect ? toFraction(e.clientX, e.clientY, rect) : null;
  };

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-auto absolute inset-0 z-30 cursor-crosshair touch-none bg-black/10"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const point = pointAt(e);
        if (!point) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ start: point, end: point });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const point = pointAt(e);
        if (point) setDrag({ start: drag.start, end: point });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const end = pointAt(e) ?? drag.end;
        const box = boxFromPoints(drag.start, end);
        setDrag(null);
        if (isUsable(box)) onDrawn(box);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {drag ? (
        <div
          className="absolute border-2 border-dashed border-link bg-link/20"
          style={boxStyle(boxFromPoints(drag.start, drag.end))}
        />
      ) : null}
    </div>
  );
}
