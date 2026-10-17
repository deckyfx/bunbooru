import { apiFor, errorMessage, unwrap } from "./api";
import { addHistory, type UploadRecord } from "./history";
import { isConfigured, loadSettings } from "./settings";
import { filenameFor, imageUrlProblem, originPattern } from "./urls";

/** Where an image came from: its address and the page it was on. */
export interface ImageSource {
  src: string;
  pageUrl?: string;
}

/**
 * Fetch an image the way the page saw it. Cookies for the image's site go
 * along only when the user granted the extension that site (so a gated image,
 * a Pixiv original say, still comes through); otherwise it's a plain fetch.
 */
async function fetchImage(src: string): Promise<Blob> {
  const pattern = originPattern(src);
  const granted = pattern ? await chrome.permissions.contains({ origins: [pattern] }) : false;
  const res = await fetch(src, { credentials: granted ? "include" : "omit", referrerPolicy: "no-referrer-when-downgrade" });
  if (!res.ok) throw new Error(`The site answered ${res.status} for this image.`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("That address didn't return an image.");
  return blob;
}

/** A short form of an address for the popup's list. */
function shorten(src: string): string {
  return src.startsWith("data:") ? "inline image" : src.length > 80 ? `${src.slice(0, 77)}…` : src;
}

/**
 * Fetch `image` and upload it to the user's Bunbooru with the sticky tags and
 * the page as its source. Records the outcome and returns it; never throws.
 */
export async function uploadImage(image: ImageSource): Promise<UploadRecord["outcome"]> {
  const outcome = await attempt(image);
  await addHistory({ at: Date.now(), src: shorten(image.src), outcome });
  return outcome;
}

async function attempt({ src, pageUrl }: ImageSource): Promise<UploadRecord["outcome"]> {
  const settings = await loadSettings();
  if (!isConfigured(settings)) return { ok: false, error: "Set your server and API key on the options page first." };
  const problem = imageUrlProblem(src);
  if (problem) return { ok: false, error: problem };

  let blob: Blob;
  try {
    blob = await fetchImage(src);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message.startsWith("The site") ? error.message : "Couldn't fetch the image.",
    };
  }

  const res = await apiFor(settings).api.v1.assets.post({
    file: new File([blob], filenameFor(src, blob.type), { type: blob.type }),
    ...(pageUrl && /^https?:/i.test(pageUrl) ? { source: pageUrl.slice(0, 2048) } : {}),
    ...(settings.tags.trim() ? { tags: settings.tags.trim() } : {}),
  });
  try {
    const asset = unwrap(res);
    // 200 = an identical file was already there (no new post, tags left alone).
    return { ok: true, assetId: asset.id, deduped: res.status === 200 };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "The upload failed.") };
  }
}
