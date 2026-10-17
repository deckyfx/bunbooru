import { treaty } from "@elysiajs/eden";

import type { App } from "@bunbooru/api";

import type { Settings } from "./settings";

/** A typed client for the user's server, authenticated by their API key. */
export function apiFor({ serverUrl, apiKey }: Settings) {
  return treaty<App>(serverUrl, { headers: { authorization: `Bearer ${apiKey}` } });
}

/**
 * A success payload, without Eden's error envelope at the type level (Eden
 * routes non-2xx bodies to `error`, so `data` is a success); throws otherwise.
 * The same contract as the web app's `unwrap`.
 */
export function unwrap<T>(res: { data: T | null; error: unknown }): Exclude<T, { error: unknown }> {
  if (res.error) throw res.error;
  if (res.data == null) throw new Error("Unexpected API response");
  return res.data as Exclude<T, { error: unknown }>;
}

/**
 * A user-facing message for a failed call: the server's own message when it
 * sent one (`{ error: { message } }`), else `fallback`. Never includes the key.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const value = error && typeof error === "object" ? (error as { value?: unknown }).value : undefined;
  const inner = value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
  const message = inner && typeof inner === "object" ? (inner as { message?: unknown }).message : undefined;
  if (typeof message === "string" && message) return message;
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (status === 401) return "The API key was refused. Check it on the options page.";
  if (status === 403) return "The API key may not do this. Use an upload-only or full key.";
  return fallback;
}
