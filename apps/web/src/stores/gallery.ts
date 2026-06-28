import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 7;

/** "fluid" = masonry (mixed aspect ratios); "classic" = uniform square grid. */
export type BoardMode = "fluid" | "classic";

interface GalleryState {
  /** Gallery column count (1–7). */
  columns: number;
  /** Overlay score / favourites on thumbnails. */
  showScores: boolean;
  /** Thumbnail layout mode. */
  boardMode: BoardMode;
  setColumns: (n: number) => void;
  setShowScores: (value: boolean) => void;
  setBoardMode: (mode: BoardMode) => void;
}

const clampColumns = (n: number): number =>
  Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(n)));

/**
 * Centralized, persisted gallery preferences (mirrors Danbooru's per-user
 * display settings). Lives in localStorage so the choice survives reloads.
 */
export const useGalleryStore = create<GalleryState>()(
  persist(
    (set) => ({
      columns: 6,
      showScores: false,
      boardMode: "fluid",
      setColumns: (n) => set({ columns: clampColumns(n) }),
      setShowScores: (value) => set({ showScores: value }),
      setBoardMode: (mode) => set({ boardMode: mode }),
    }),
    { name: "bunbooru:gallery" },
  ),
);
