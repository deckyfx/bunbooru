/**
 * Where the service worker parks shared files until the upload page takes
 * them: Cache Storage, which both the worker and the page can reach.
 */
export const SHARE_CACHE = "bunbooru-share";

/** The cache key of the `index`-th shared file. */
export const sharedFileKey = (index: number): string => `/__shared/${index}`;

/** The header carrying a shared file's name (a cached Response has no filename). */
export const SHARED_NAME_HEADER = "x-shared-name";
