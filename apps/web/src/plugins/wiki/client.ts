import { treaty } from "@elysiajs/eden";

import type { WikiPluginApp } from "@bunbooru/plugin-wiki";

import { pathParam, treatyOptions, treatyOrigin, unwrap } from "../../lib/api";

/**
 * Typed Eden client for the wiki plugin's routes, built from the plugin's own
 * exported {@link WikiPluginApp} type (paths include the
 * `/api/v1/plugins/wiki` prefix).
 */
export const wikiPluginApi = treaty<WikiPluginApp>(treatyOrigin, treatyOptions);

/** The plugin's routes. */
export const wikiApi = wikiPluginApi.api.v1.plugins.wiki;

/**
 * One page's routes. Titles are free-form (`ac/dc`, `what?`, `50%`) and Eden
 * splices path params in unencoded, so the title always goes through
 * {@link pathParam}; the server decodes it.
 */
export function wikiPage(title: string) {
  return wikiApi.pages({ title: pathParam(title) });
}

/** Query keys: every wiki query sits under this prefix, so a change refreshes them all. */
export const WIKI_KEY = ["wiki"] as const;

/** The key of one page's query, shared by the page view and the search excerpt. */
export function pageKey(title: string) {
  return [...WIKI_KEY, "page", title] as const;
}

/** Longest page body the server accepts (after trimming). */
export const MAX_BODY = 20_000;

/** A page, or null when it doesn't exist (a 404 is an answer here, not an error). */
export async function fetchPage(title: string) {
  const res = await wikiPage(title).get();
  if (res.status === 404) return null;
  return unwrap(res);
}

/** A page, as the routes return it. */
export type WikiPageDto = NonNullable<Awaited<ReturnType<typeof fetchPage>>>;

/** Whether a thrown Eden error is the API's 409: the page changed since it was loaded. */
export function isStaleEdit(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { status?: unknown }).status === 409;
}
