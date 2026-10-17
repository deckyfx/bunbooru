import { treaty } from "@elysiajs/eden";

import type { NotesPluginApp } from "@bunbooru/plugin-notes";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the notes plugin's routes, built from the plugin's own
 * exported {@link NotesPluginApp} type (paths include the
 * `/api/v1/plugins/notes` prefix).
 */
export const notesPluginApi = treaty<NotesPluginApp>(treatyOrigin, treatyOptions);

/** The plugin's routes. */
export const notesApi = notesPluginApi.api.v1.plugins.notes;

/** Query keys: every notes query sits under this prefix, so a change refreshes them all. */
export const NOTES_KEY = ["notes"] as const;

/** Longest note the server accepts (after trimming). */
export const MAX_BODY = 1000;

/** A box over the image, in fractions of it (0..1). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One note, as the routes return it (`canEdit` is computed for the caller). */
export interface NoteDto extends Box {
  id: number;
  body: string;
  authorName: string | null;
  updatedAt: string;
  canEdit: boolean;
}
