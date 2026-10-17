/** What the user configured on the options page, plus the sticky tags. */
export interface Settings {
  /** The Bunbooru origin, e.g. `https://booru.example` (empty until set). */
  serverUrl: string;
  /** An upload-only `bnb_…` API key (empty until set). Never logged. */
  apiKey: string;
  /** Space-separated tags added to every upload until changed (may be empty). */
  tags: string;
}

const DEFAULTS: Settings = { serverUrl: "", apiKey: "", tags: "" };

/**
 * The settings, from `chrome.storage.local`: extension-private storage, never
 * a page's `localStorage` and not synced across devices (a key belongs to
 * one device).
 */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return {
    serverUrl: typeof stored.serverUrl === "string" ? stored.serverUrl : DEFAULTS.serverUrl,
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey : DEFAULTS.apiKey,
    tags: typeof stored.tags === "string" ? stored.tags : DEFAULTS.tags,
  };
}

/** Save some of the settings. */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Whether there is enough to upload with. */
export function isConfigured(settings: Settings): boolean {
  return settings.serverUrl !== "" && settings.apiKey !== "";
}
