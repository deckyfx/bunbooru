import { useMutation } from "@tanstack/react-query";

import { unwrap } from "../../lib/api";
import { NoteTextForm } from "./NoteTextForm";
import { notesApi, type Box } from "./client";
import { boxStyle, popoverPlacement } from "./geometry";

/**
 * A drawn box waiting for its text: the outline where the note will go, and a
 * small form beside it. Saving posts the note; Cancel or Escape drops it.
 */
export function NoteComposer({
  assetId,
  box,
  onSaved,
  onCancel,
}: {
  assetId: number;
  box: Box;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const add = useMutation({
    mutationFn: async (body: string) => unwrap(await notesApi.assets({ id: String(assetId) }).post({ ...box, body })),
    onSuccess: onSaved,
  });

  return (
    <div className="pointer-events-auto absolute z-40" style={boxStyle(box)}>
      <div className="h-full w-full border-2 border-dashed border-link bg-link/20" aria-hidden="true" />
      <div className={`absolute ${popoverPlacement(box)} w-64 max-w-[80vw]`}>
        <div className="rounded border border-line bg-surface p-2 text-ink shadow-lg">
          <NoteTextForm
            label="New note text"
            submitLabel="Save note"
            pending={add.isPending}
            error={add.error}
            onSubmit={(body) => add.mutateAsync(body)}
            onCancel={onCancel}
          />
        </div>
      </div>
    </div>
  );
}
