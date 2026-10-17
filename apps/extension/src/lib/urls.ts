/**
 * Pure URL rules for the extension, kept free of `chrome.*` so they can be
 * unit-tested.
 */

/** Why an address can't be used, or null when it can. */
export type UrlProblem = string | null;

/**
 * The server address the user typed, as an origin (`https://booru.example`),
 * or a problem. A path is dropped: the API lives at the origin's `/api/v1`.
 */
export function normalizeServerUrl(input: string): { origin: string } | { problem: string } {
  const trimmed = input.trim();
  if (!trimmed) return { problem: "Enter your Bunbooru address." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { problem: "That isn't a valid address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { problem: "Use an http(s) address." };
  }
  return { origin: url.origin };
}

/**
 * Whether the extension may fetch `src` to upload it. Only web addresses and
 * inline `data:` images: never `file:`, browser-internal or extension pages,
 * and not `blob:` (a page's blob URL can't be read from the extension).
 */
export function imageUrlProblem(src: string): UrlProblem {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return "Not a valid image address.";
  }
  if (url.protocol === "https:" || url.protocol === "http:") return null;
  if (url.protocol === "data:") return /^data:image\//i.test(src) ? null : "Not an image.";
  if (url.protocol === "blob:") return "This image is only readable inside the page. Save it and upload the file.";
  return `Can't upload from ${url.protocol} addresses.`;
}

/** A filename for an image fetched from `src` (the server sniffs the real type). */
export function filenameFor(src: string, type: string): string {
  const ext = /^image\/([a-z0-9.+-]+)$/i.exec(type)?.[1]?.replace("jpeg", "jpg") ?? "img";
  try {
    const url = new URL(src);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
      const clean = last.replace(/[^\w.-]+/g, "_").slice(0, 100);
      if (clean) return /\.[a-z0-9]{2,5}$/i.test(clean) ? clean : `${clean}.${ext}`;
    }
  } catch {
    // fall through to a generic name
  }
  return `image.${ext}`;
}

/** Booru-style tags from free text: whitespace-separated, lowercased, deduped. */
export function parseTags(input: string): string[] {
  return [...new Set(input.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

/**
 * The host permission pattern for a URL, for `chrome.permissions`. Without the
 * port: Firefox doesn't support ports in match patterns (one with a port
 * matches nothing there), and in Chrome a portless pattern covers every port.
 */
export function originPattern(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? `${protocol}//${hostname}/*` : null;
  } catch {
    return null;
  }
}
