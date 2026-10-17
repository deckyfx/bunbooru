import { isConfigured, loadSettings } from "./lib/settings";
import { uploadImage, type ImageSource } from "./lib/upload";

/**
 * The extension's background (a service worker in Chrome, an event page in
 * Firefox). It acts only on a user gesture: a context-menu click, or a request
 * from the extension's own popup. No content script can ask it for anything,
 * so a page can never make it fetch (with the user's cookies) and upload.
 */

const MENU_IMAGE = "bunbooru-upload-image";
const MENU_PAGE = "bunbooru-upload-page";

/** The most images "upload all" takes from one page. */
const PAGE_LIMIT = 100;

chrome.runtime.onInstalled.addListener(() => {
  // Menus persist across worker restarts once created here.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_IMAGE, title: "Upload to Bunbooru", contexts: ["image"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Upload all images on this page", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_IMAGE && info.srcUrl) {
    void uploadAll([{ src: info.srcUrl, pageUrl: info.pageUrl }]);
  } else if (info.menuItemId === MENU_PAGE && tab?.id !== undefined) {
    void uploadPage(tab.id);
  }
});

/** A request from the popup. */
interface PopupMessage {
  type: "upload-page";
  tabId: number;
}

function isPopupMessage(message: unknown): message is PopupMessage {
  const m = message as Partial<PopupMessage> | null;
  return m?.type === "upload-page" && typeof m.tabId === "number";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own pages (they have no `tab`); never a content
  // script or a web page.
  if (sender.id !== chrome.runtime.id || sender.tab || !isPopupMessage(message)) return false;
  void uploadPage(message.tabId).then(sendResponse);
  return true; // answering asynchronously
});

/** Open the uploaded post when its notification is clicked. */
chrome.notifications.onClicked.addListener((notificationId) => {
  const match = /^post:(\d+)$/.exec(notificationId);
  if (!match) return;
  void loadSettings().then(({ serverUrl }) => {
    if (serverUrl) void chrome.tabs.create({ url: `${serverUrl}/posts/${match[1]}` });
  });
});

/**
 * Collect the page's images (in the page, via the activeTab grant the gesture
 * gave). Small images (icons, avatars) are skipped.
 */
async function uploadPage(tabId: number): Promise<{ count: number }> {
  let images: ImageSource[] = [];
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (limit: number) => {
        const seen = new Set<string>();
        for (const img of Array.from(document.images)) {
          if (img.naturalWidth < 150 || img.naturalHeight < 150) continue;
          const src = img.currentSrc || img.src;
          if (src) seen.add(src);
          if (seen.size >= limit) break;
        }
        return { srcs: [...seen], pageUrl: location.href };
      },
      args: [PAGE_LIMIT],
    });
    const found = result?.result;
    if (found) images = found.srcs.map((src) => ({ src, pageUrl: found.pageUrl }));
  } catch {
    await notify("page", "Bunbooru", "This page can't be read (a browser or store page?).");
    return { count: 0 };
  }
  if (images.length === 0) {
    await notify("page", "Bunbooru", "No large images on this page.");
    return { count: 0 };
  }
  await uploadAll(images);
  return { count: images.length };
}

/** Upload `images` one after another, showing progress on the badge, then report. */
async function uploadAll(images: ImageSource[]): Promise<void> {
  if (!isConfigured(await loadSettings())) {
    await notify("setup", "Bunbooru", "Set your server and API key first.");
    void chrome.runtime.openOptionsPage();
    return;
  }
  let added = 0;
  let existing = 0;
  let lastPost: number | null = null;
  const errors: string[] = [];
  for (const [index, image] of images.entries()) {
    await chrome.action.setBadgeText({ text: images.length > 1 ? `${images.length - index}` : "…" });
    const outcome = await uploadImage(image);
    if (outcome.ok) {
      lastPost = outcome.assetId;
      if (outcome.deduped) existing += 1;
      else added += 1;
    } else errors.push(outcome.error);
  }
  await chrome.action.setBadgeText({ text: "" });

  if (images.length === 1) {
    if (lastPost !== null) {
      await notify(`post:${lastPost}`, existing ? "Already in your library" : "Uploaded", `Post #${lastPost}. Click to open.`);
    } else await notify("error", "Upload failed", errors[0] ?? "Unknown error");
    return;
  }
  const parts = [`${added} uploaded`, ...(existing ? [`${existing} already there`] : []), ...(errors.length ? [`${errors.length} failed`] : [])];
  await notify("batch", "Bunbooru", parts.join(" · ") + (errors[0] ? `\n${errors[0]}` : ""));
}

/** A system notification (replacing the previous one of the same id). */
async function notify(id: string, title: string, message: string): Promise<void> {
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message,
  });
}
