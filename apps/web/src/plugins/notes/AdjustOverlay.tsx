import { useEffect, useId, useRef, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { CORNERS, nudgeBox, sameBox, toSavable, type Corner } from "./adjust";
import { NOTES_KEY, notesApi, type Box, type NoteDto } from "./client";
import { boxStyle, popoverPlacement } from "./geometry";
import { useBoxDrag } from "./useBoxDrag";

/** Where each corner handle sits (its centre on the corner) and its resize cursor. */
const CORNER_CLASS: Record<Corner, string> = {
  nw: "-left-2.5 -top-2.5 cursor-nwse-resize",
  ne: "-right-2.5 -top-2.5 cursor-nesw-resize",
  sw: "-bottom-2.5 -left-2.5 cursor-nesw-resize",
  se: "-bottom-2.5 -right-2.5 cursor-nwse-resize",
};

/** Corner names for the handles' accessible labels. */
const CORNER_LABEL: Record<Corner, string> = {
  nw: "top-left",
  ne: "top-right",
  sw: "bottom-left",
  se: "bottom-right",
};

/**
 * One note in adjust mode: its box with a move handle over the body and a
 * resize handle on each corner, previewed live while dragging (mouse, touch or
 * pen) and clamped to the image. From the keyboard, arrows move it, Shift+arrows
 * resize it, Enter saves. Done saves the new box with one PATCH and writes the
 * answer into the notes cache; Cancel (or Escape, handled by the layer) drops
 * the draft. A failed save shows its error and stays in adjust mode.
 */
export function AdjustOverlay({
  note,
  assetId,
  onDone,
  onCancel,
  onSavingChange,
}: {
  note: NoteDto;
  assetId: number;
  onDone: () => void;
  onCancel: () => void;
  /** Told when a save starts and settles, so the layer can hold off Escape meanwhile. */
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const hintId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const original: Box = { x: note.x, y: note.y, w: note.w, h: note.h };
  const [draft, setDraft] = useState<Box>(original);

  const save = useMutation({
    mutationFn: async (box: Box) => unwrap(await notesApi.notes({ id: String(note.id) }).patch(box)),
    onSuccess: (updated) => {
      queryClient.setQueriesData<NoteDto[]>({ queryKey: [...NOTES_KEY, "asset", assetId] }, (old) =>
        old?.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      onDone();
    },
  });

  // Report the in-flight save to the layer: its page-wide Escape must not
  // "cancel" a save that the server will complete anyway. Cleared on unmount.
  useEffect(() => {
    onSavingChange(save.isPending);
    return () => onSavingChange(false);
  }, [save.isPending, onSavingChange]);

  const drag = useBoxDrag({
    box: draft,
    onChange: setDraft,
    // The overlay sits directly in the notes layer, which is exactly the image.
    layer: () => rootRef.current?.parentElement ?? null,
    disabled: save.isPending,
  });

  /** Save the draft, or just leave if nothing moved. */
  const done = () => {
    if (save.isPending) return;
    if (sameBox(draft, original)) {
      onDone();
      return;
    }
    save.mutate(toSavable(draft));
  };

  return (
    <div ref={rootRef} className="pointer-events-auto absolute z-40" style={boxStyle(draft)}>
      <div
        role="group"
        aria-label="Adjust note"
        className="relative h-full w-full border-2 border-dashed border-link bg-link/20"
        onKeyDown={(e) => {
          if (save.isPending) return;
          if (e.key === "Enter") {
            e.preventDefault();
            done();
            return;
          }
          const next = nudgeBox(draft, e.key, e.shiftKey);
          if (next) {
            e.preventDefault();
            setDraft(next);
          }
        }}
      >
        <button
          type="button"
          aria-label="Move note"
          aria-describedby={hintId}
          title="Drag to move"
          // Adjust mode opens on a deliberate action, so take focus for the keys.
          autoFocus
          className="absolute inset-0 cursor-move touch-none outline-none focus-visible:ring-2 focus-visible:ring-link"
          {...drag("move")}
        />
        {CORNERS.map((corner) => (
          <button
            key={corner}
            type="button"
            // Pointer-only: from the keyboard, Shift+arrows resize instead.
            tabIndex={-1}
            aria-label={`Resize note from the ${CORNER_LABEL[corner]} corner`}
            className={`absolute flex h-5 w-5 touch-none items-center justify-center ${CORNER_CLASS[corner]}`}
            {...drag(corner)}
          >
            <span className="h-2.5 w-2.5 rounded-sm border border-white bg-link shadow" aria-hidden="true" />
          </button>
        ))}
      </div>

      {/* py-2 clears the corner handles whichever side the toolbar lands on. */}
      <div className={`absolute ${popoverPlacement(draft)} w-max max-w-72 py-2`}>
        <div className="rounded border border-line bg-surface p-2 text-[12px] text-ink shadow-lg">
          <p id={hintId} role="status" className="sr-only">
            Adjusting note: arrows move, Shift+arrows resize, Enter to save, Escape to cancel.
          </p>
          <p className="text-[11px] text-muted" aria-hidden="true">
            Drag to move, corners to resize.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={done}
              disabled={save.isPending}
              className="flex items-center gap-1 rounded bg-link px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Done
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={save.isPending}
              className="rounded border border-line px-3 py-1 hover:border-link disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
          {save.isError ? (
            <p role="alert" className="mt-1 text-tag-artist">
              {authErrorMessage(save.error, "Couldn’t save the note’s position.")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
