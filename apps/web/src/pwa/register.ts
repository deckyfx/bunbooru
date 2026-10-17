import { SHARE_CACHE, SHARED_NAME_HEADER, sharedFileKey } from "./share-cache";

/**
 * Make the site installable (manifest) and able to receive shares (the
 * service worker). Production builds only, where `sw.js` and the manifest are
 * emitted at the site root, and only in a secure context (HTTPS or localhost):
 * browsers refuse service workers anywhere else.
 */
export function registerPwa(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;

  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = "/manifest.webmanifest";
  document.head.append(link);

  // Registered after load so it never competes with the app's first paint.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("service worker registration failed", error);
    });
  });
}

/**
 * Take the files a share left in Cache Storage (see `sw.ts`), emptying it.
 * `count` is what the worker reported in the redirect.
 */
export async function takeSharedFiles(count: number): Promise<File[]> {
  if (!("caches" in window)) return [];
  const cache = await caches.open(SHARE_CACHE);
  const files: File[] = [];
  for (let index = 0; index < count; index++) {
    const response = await cache.match(sharedFileKey(index));
    if (!response) continue;
    const blob = await response.blob();
    const name = decodeURIComponent(response.headers.get(SHARED_NAME_HEADER) ?? "") || `shared-${index + 1}`;
    files.push(new File([blob], name, { type: blob.type }));
  }
  await caches.delete(SHARE_CACHE);
  return files;
}
