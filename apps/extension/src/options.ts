import { apiFor, errorMessage, unwrap } from "./lib/api";
import { loadSettings, saveSettings } from "./lib/settings";
import { normalizeServerUrl } from "./lib/urls";

/** An element the page is known to have. */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from options.html`);
  return found as T;
}

const ALL_SITES = { origins: ["<all_urls>"] };

async function main(): Promise<void> {
  const settings = await loadSettings();
  const server = el<HTMLInputElement>("server");
  const key = el<HTMLInputElement>("key");
  const status = el("status");
  server.value = settings.serverUrl;
  key.value = settings.apiKey;

  el<HTMLFormElement>("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const normalized = normalizeServerUrl(server.value);
    if ("problem" in normalized) return show(normalized.problem, "bad");
    const apiKey = key.value.trim();
    if (!/^bnb_[0-9a-f]{64}$/i.test(apiKey)) return show("That doesn't look like a Bunbooru API key (bnb_…).", "bad");

    // The extension may only talk to origins it was granted (part of the
    // click, so the browser shows its prompt).
    const granted = await chrome.permissions.request({ origins: [`${normalized.origin}/*`] });
    if (!granted) return show("The extension needs permission to reach your server.", "bad");

    server.value = normalized.origin;
    await saveSettings({ serverUrl: normalized.origin, apiKey });
    show("Testing…", "muted");
    try {
      const { user } = unwrap(await apiFor({ serverUrl: normalized.origin, apiKey, tags: "" }).api.v1.auth.me.get());
      if (user) show(`Connected as ${user.username}. Right-click any image to upload it.`, "good");
      else show("The server doesn't know this key.", "bad");
    } catch (error) {
      show(errorMessage(error, `Can't reach ${normalized.origin}.`), "bad");
    }
  });

  el("grant-sites").addEventListener("click", async () => {
    await chrome.permissions.request(ALL_SITES);
    await showSites();
  });
  await showSites();

  function show(message: string, tone: "good" | "bad" | "muted"): void {
    status.textContent = message;
    status.className = tone;
  }
}

async function showSites(): Promise<void> {
  const granted = await chrome.permissions.contains(ALL_SITES);
  el("sites-status").textContent = granted
    ? "Granted: images come with the site's cookies, as you see them."
    : "Not granted: images are fetched without cookies.";
  el("grant-sites").hidden = granted;
}

void main();
