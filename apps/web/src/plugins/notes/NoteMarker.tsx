import { useEffect, useId, useRef, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Move, Pencil, Trash2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { NoteTextForm } from "./NoteTextForm";
import { notesApi, type NoteDto } from "./client";
import { boxStyle, excerpt, popoverPlacement } from "./geometry";

const ICON_BUTTON_CLASS =
  "rounded p-1 text-muted hover:bg-bg hover:text-link disabled:cursor-not-allowed disabled:opacity-60";

/**
 * One note over the image: a translucent, focusable box whose text shows in a
 * popover on hover, on keyboard focus, or pinned open by a click or tap (touch
 * has no hover). The text is plain (`whitespace-pre-wrap`), never HTML. Its
 * author or an admin gets Edit text, Move / resize (`onAdjust`) and Delete in
 * the popover. While another note is being adjusted it is `inactive`: still
 * shown, but inert (no pointer, no focus, no popover).
 */
export function NoteMarker({
  note,
  onChanged,
  onAdjust,
  inactive = false,
}: {
  note: NoteDto;
  onChanged: () => void;
  onAdjust: () => void;
  inactive?: boolean;
}) {
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const save = useMutation({
    mutationFn: async (body: string) => unwrap(await notesApi.notes({ id: String(note.id) }).patch({ body })),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      // A 204 has no body to unwrap.
      const res = await notesApi.notes({ id: String(note.id) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: onChanged,
  });

  const busy = editing || confirmingDelete;
  const open = !inactive && (hovered || focused || pinned || busy);

  // A pinned or busy popover closes on a press anywhere else.
  useEffect(() => {
    if (!pinned && !busy) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setPinned(false);
        setEditing(false);
        setConfirmingDelete(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned, busy]);

  const close = () => {
    setPinned(false);
    setEditing(false);
    setConfirmingDelete(false);
  };

  const author = note.authorName ?? "unknown";

  return (
    <div
      ref={rootRef}
      className={`${inactive ? "pointer-events-none opacity-60" : "pointer-events-auto"} absolute`}
      style={{ ...boxStyle(note), zIndex: open ? 20 : 10 }}
      inert={inactive}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      // Keyboard focus only (`:focus-visible`): a click or tap also focuses the
      // button, and counting that would keep the popover open after a second
      // tap meant to close it. Clicks and taps go through `pinned` instead.
      onFocus={(e) => setFocused(e.target instanceof Element && e.target.matches(":focus-visible"))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
          setHovered(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={`Note: ${excerpt(note.body)}`}
        aria-expanded={open}
        aria-controls={popoverId}
        // The layer returns focus here when this note leaves adjust mode.
        data-note-id={note.id}
        onClick={() => setPinned((value) => !value)}
        className="block h-full w-full cursor-help border border-black/60 bg-yellow-100/30 outline-none ring-1 ring-white/70 hover:bg-yellow-100/50 focus-visible:ring-2 focus-visible:ring-link"
      />
      <div
        id={popoverId}
        role="group"
        aria-label={`Note by ${author}`}
        hidden={!open}
        className={`absolute ${popoverPlacement(note)} w-max min-w-40 max-w-72`}
      >
        <div className="rounded border border-line bg-surface p-2 text-left text-[12px] text-ink shadow-lg">
          {editing ? (
            <NoteTextForm
              initial={note.body}
              label="Edit note text"
              submitLabel="Save"
              pending={save.isPending}
              error={save.error}
              onSubmit={(body) => save.mutateAsync(body)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <p className="whitespace-pre-wrap wrap-break-word">{note.body}</p>
          )}
          <div className="mt-1 flex items-center gap-1 text-[11px] text-muted">
            <span>{author}</span>
            {note.canEdit && !editing && !confirmingDelete ? (
              <span className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Edit note text"
                  title="Edit text"
                  onClick={() => {
                    save.reset();
                    setEditing(true);
                  }}
                  disabled={remove.isPending}
                  className={ICON_BUTTON_CLASS}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Move or resize note"
                  title="Move / resize"
                  onClick={onAdjust}
                  disabled={remove.isPending}
                  className={ICON_BUTTON_CLASS}
                >
                  <Move className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Delete note"
                  title="Delete"
                  onClick={() => {
                    remove.reset();
                    setConfirmingDelete(true);
                  }}
                  disabled={remove.isPending}
                  className={`${ICON_BUTTON_CLASS} hover:text-tag-artist`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
            ) : null}
          </div>
          {confirmingDelete ? (
            <div role="group" aria-label="Confirm note deletion" className="mt-1 flex items-center gap-2">
              <span className="text-tag-artist">Delete this note?</span>
              <button
                type="button"
                onClick={() => {
                  if (!remove.isPending) remove.mutate();
                }}
                disabled={remove.isPending}
                className="rounded border border-tag-artist px-2 py-0.5 font-bold text-tag-artist disabled:cursor-not-allowed disabled:opacity-60"
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={remove.isPending}
                className="rounded border border-line px-2 py-0.5 hover:border-link"
              >
                Cancel
              </button>
            </div>
          ) : null}
          {remove.isError ? (
            <p role="alert" className="mt-0.5 text-tag-artist">
              {authErrorMessage(remove.error, "Couldn’t delete the note.")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
