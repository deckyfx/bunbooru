/** One finished upload, as the popup lists it. */
export interface UploadRecord {
  at: number;
  /** The image address, shortened for display. */
  src: string;
  outcome: { ok: true; assetId: number; deduped: boolean } | { ok: false; error: string };
}

const KEY = "history";
const LIMIT = 20;

/** The most recent uploads, newest first. */
export async function loadHistory(): Promise<UploadRecord[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? (stored[KEY] as UploadRecord[]) : [];
}

/** Record an upload's outcome (kept in extension storage, so it outlives the worker). */
export async function addHistory(record: UploadRecord): Promise<void> {
  const history = await loadHistory();
  await chrome.storage.local.set({ [KEY]: [record, ...history].slice(0, LIMIT) });
}
