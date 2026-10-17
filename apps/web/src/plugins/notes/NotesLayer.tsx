import { useEffect, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, StickyNote } from "lucide-react";

import { unwrap } from "../../lib/api";
import { useCurrentUser } from "../../lib/auth";
import type { SlotPropsMap } from "../slots";
import { DrawSurface } from "./DrawSurface";
import { NoteComposer } from "./NoteComposer";
import { NoteMarker } from "./NoteMarker";
import { NOTES_KEY, notesApi, type Box } from "./client";

/** What the layer is doing: showing notes, waiting for a drag, or taking a new note's text. */
type Mode = { kind: "view" } | { kind: "draw" } | { kind: "compose"; box: Box };

/** Where "Place in the center" puts a note, for keyboard users who can't drag. */
const CENTER_BOX: Box = { x: 0.35, y: 0.4, w: 0.3, h: 0.2 };

const CHIP_CLASS =
  "pointer-events-auto flex items-center gap-1 rounded border border-line bg-surface/85 px-1.5 py-0.5 text-[11px] text-ink shadow-sm hover:border-link disabled:opacity-60";

/**
 * The post image's notes (`post-detail-image`, a click-through layer exactly
 * over the image): each note as a box positioned in percentages, a "Notes (N)"
 * chip that hides or shows them all, and for a signed-in viewer an "Add note"
 * button that switches into draw mode (drag a box, type the text, save;
 * Escape cancels).
 */
export function NotesLayer({ asset }: SlotPropsMap["post-detail-image"]) {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const [shown, setShown] = useState(true);
  const [mode, setMode] = useState<Mode>({ kind: "view" });

  const notes = useQuery({
    // Keyed by viewer too: each note's `canEdit` depends on who's asking.
    queryKey: [...NOTES_KEY, "asset", asset.id, user?.id ?? null],
    queryFn: async () => unwrap(await notesApi.assets({ id: String(asset.id) }).get()).items,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: NOTES_KEY });

  // Escape leaves draw or compose mode from anywhere on the page.
  useEffect(() => {
    if (mode.kind === "view") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMode({ kind: "view" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode.kind]);

  const items = notes.data ?? [];
  // Signed out with nothing to show: stay out of the way entirely.
  if (!user && items.length === 0) return null;

  return (
    <div className="absolute inset-0">
      {/* Kept visible while drawing (under the draw surface), so a new note can avoid the old ones. */}
      {shown ? items.map((note) => <NoteMarker key={note.id} note={note} onChanged={refresh} />) : null}

      {mode.kind === "draw" ? (
        <>
          <DrawSurface onDrawn={(box) => setMode({ kind: "compose", box })} />
          <div
            role="status"
            className="pointer-events-auto absolute left-1 top-1 z-40 flex flex-wrap items-center gap-1 rounded border border-line bg-surface/90 px-2 py-1 text-[11px] text-ink shadow-sm"
          >
            <span>Drag over the image to place a note.</span>
            <button
              type="button"
              onClick={() => setMode({ kind: "compose", box: CENTER_BOX })}
              className="rounded border border-line px-1.5 hover:border-link"
            >
              Place in the center
            </button>
            <button
              type="button"
              onClick={() => setMode({ kind: "view" })}
              className="rounded border border-line px-1.5 hover:border-link"
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}

      {mode.kind === "compose" ? (
        <NoteComposer
          assetId={asset.id}
          box={mode.box}
          onSaved={() => {
            setShown(true);
            setMode({ kind: "view" });
            refresh();
          }}
          onCancel={() => setMode({ kind: "view" })}
        />
      ) : null}

      {mode.kind === "view" ? (
        <div className="absolute right-1 top-1 z-30 flex gap-1 opacity-80 focus-within:opacity-100 hover:opacity-100">
          {items.length > 0 ? (
            <button
              type="button"
              aria-pressed={shown}
              title={shown ? "Hide notes" : "Show notes"}
              onClick={() => setShown((value) => !value)}
              className={CHIP_CLASS}
            >
              <StickyNote className="h-3 w-3" aria-hidden="true" />
              Notes ({items.length})
            </button>
          ) : null}
          {user ? (
            <button type="button" onClick={() => setMode({ kind: "draw" })} className={CHIP_CLASS}>
              <Plus className="h-3 w-3" aria-hidden="true" />
              Add note
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
