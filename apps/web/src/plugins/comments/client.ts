import { treaty } from "@elysiajs/eden";

import type { CommentsPluginApp } from "@bunbooru/plugin-comments";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the comments plugin's routes, built from the plugin's
 * own exported {@link CommentsPluginApp} type (paths include the
 * `/api/v1/plugins/comments` prefix).
 */
export const commentsPluginApi = treaty<CommentsPluginApp>(treatyOrigin, treatyOptions);

/** The plugin's routes. */
export const commentsApi = commentsPluginApi.api.v1.plugins.comments;

/** Query keys: every comment query sits under this prefix, so a change refreshes them all. */
export const COMMENTS_KEY = ["comments"] as const;

/** Longest comment the server accepts (after trimming). */
export const MAX_BODY = 2000;

/** One comment, as the routes return it (`canEdit` is computed for the caller). */
export interface CommentDto {
  id: number;
  assetId: number;
  authorName: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  canEdit: boolean;
}
