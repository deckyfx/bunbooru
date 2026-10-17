import { create } from "zustand";

/** Files handed to the upload page from elsewhere (a paste, a drop, a share). */
export interface PendingBatch {
  /** Distinguishes one hand-off from the next. */
  id: number;
  files: File[];
}

interface PendingUploadsState {
  batch: PendingBatch | null;
  /** Hand `files` to the upload page (replacing any batch it hasn't taken yet). */
  hand: (files: File[]) => void;
  /** The upload page took the batch. */
  clear: (id: number) => void;
}

let nextId = 1;

/**
 * In-memory hand-off between whatever captured files (the global paste/drop
 * handler, the PWA share target) and the upload page, which takes and uploads
 * them. Not persisted: a File can't be.
 */
export const usePendingUploads = create<PendingUploadsState>()((set) => ({
  batch: null,
  hand: (files) => set({ batch: { id: nextId++, files } }),
  clear: (id) => set((state) => (state.batch?.id === id ? { batch: null } : state)),
}));

/** The image files among `files` (other types are ignored). */
export function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter((file) => file.type.startsWith("image/"));
}
