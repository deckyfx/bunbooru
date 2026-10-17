import { apiFor, errorMessage, unwrap } from "./lib/api";
import { loadHistory } from "./lib/history";
import { isConfigured, loadSettings, saveSettings, type Settings } from "./lib/settings";

/** An element the page is known to have. */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from popup.html`);
  return found as T;
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  el("open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  el("settings-link").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  if (!isConfigured(settings)) {
    el("setup").hidden = false;
    return;
  }
  el("ready").hidden = false;
  void showWho(settings);
  wireTags(settings);
  wireUploadPage();
  await showHistory(settings);
}

/** Confirm the key works: whose it is. */
async function showWho(settings: Settings): Promise<void> {
  const who = el("who");
  try {
    const { user } = unwrap(await apiFor(settings).api.v1.auth.me.get());
    who.textContent = user ? `Uploading to ${new URL(settings.serverUrl).host} as ${user.username}` : "The API key isn't valid any more.";
    if (!user) who.className = "bad";
  } catch (error) {
    who.textContent = errorMessage(error, `Can't reach ${settings.serverUrl}.`);
    who.className = "bad";
  }
}

/** Sticky tags, saved as typed, with suggestions for the word being typed. */
function wireTags(settings: Settings): void {
  const input = el<HTMLInputElement>("tags");
  const list = el<HTMLDataListElement>("tag-suggestions");
  input.value = settings.tags;
  let pending: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    void saveSettings({ tags: input.value });
    clearTimeout(pending);
    pending = setTimeout(() => void suggest(), 200);
  });

  async function suggest(): Promise<void> {
    const words = input.value.split(/\s+/);
    const last = words.at(-1) ?? "";
    if (last.length < 2) return;
    try {
      const tags = unwrap(await apiFor(settings).api.v1.tags.get({ query: { q: last, limit: 8 } }));
      const prefix = words.slice(0, -1).join(" ");
      list.replaceChildren(
        ...tags.map((tag) => {
          const option = document.createElement("option");
          option.value = `${prefix ? `${prefix} ` : ""}${tag.name} `;
          option.label = `${tag.name} (${tag.postCount})`;
          return option;
        }),
      );
    } catch {
      // Suggestions are a convenience; typing still works without them.
    }
  }
}

function wireUploadPage(): void {
  const button = el<HTMLButtonElement>("upload-page");
  const status = el("page-status");
  button.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    button.disabled = true;
    status.textContent = "Uploading… you can close this; a notification reports the result.";
    await chrome.runtime.sendMessage({ type: "upload-page", tabId: tab.id });
    status.textContent = "Done.";
    button.disabled = false;
    await showHistory(await loadSettings());
  });
}

async function showHistory(settings: Settings): Promise<void> {
  const history = await loadHistory();
  el("history-empty").hidden = history.length > 0;
  el("history").replaceChildren(
    ...history.map((record) => {
      const item = document.createElement("li");
      if (record.outcome.ok) {
        const link = document.createElement("a");
        link.href = `${settings.serverUrl}/posts/${record.outcome.assetId}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = record.outcome.deduped ? `already there: #${record.outcome.assetId}` : `post #${record.outcome.assetId}`;
        item.append(link);
      } else {
        const error = document.createElement("span");
        error.className = "bad";
        error.textContent = record.outcome.error;
        item.append(error);
      }
      const src = document.createElement("div");
      src.className = "muted";
      src.textContent = record.src;
      item.append(src);
      return item;
    }),
  );
}

void main();
