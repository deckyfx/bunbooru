import { SHARE_CACHE, SHARED_NAME_HEADER, sharedFileKey } from "./share-cache";

/**
 * Bunbooru's service worker. Its one job is the PWA share target: Android
 * delivers a share as a `POST /share` (multipart, field `media`). The worker
 * parks the images in Cache Storage and redirects to the upload page, which
 * takes and uploads them. Nothing else is intercepted or cached, so the site
 * behaves exactly as without it.
 *
 * Typed by hand: the app's tsconfig uses the DOM lib, and pulling in the
 * WebWorker lib for one file would clash with it.
 */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface WorkerScope {
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
}
const worker = self as unknown as WorkerScope;

worker.addEventListener("install", (event) => {
  event.waitUntil(worker.skipWaiting());
});
worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(receiveShare(event.request));
  }
});

/** Park the shared images, then send the browser to the upload page. */
async function receiveShare(request: Request): Promise<Response> {
  let count = 0;
  try {
    const form = await request.formData();
    const images = form
      .getAll("media")
      .filter((entry): entry is File => entry instanceof File && entry.type.startsWith("image/"));
    // A fresh cache per share: anything left from an unfinished one is stale.
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    for (const [index, file] of images.entries()) {
      await cache.put(
        sharedFileKey(index),
        new Response(file, {
          headers: { "content-type": file.type, [SHARED_NAME_HEADER]: encodeURIComponent(file.name) },
        }),
      );
    }
    count = images.length;
  } catch {
    // An unreadable share lands on the upload page with nothing to take,
    // which says so; failing the navigation would show a browser error page.
  }
  return Response.redirect(`/uploads/new?shared=${count}`, 303);
}
