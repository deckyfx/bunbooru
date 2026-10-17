/**
 * Where the service worker parks shared files until the upload page takes
 * them: Cache Storage, which both the worker and the page can reach.
 */
export const SHARE_CACHE = "bunbooru-share";

/** The cache key of the `index`-th shared file. */
export const sharedFileKey = (index: number): string => `/__shared/${index}`;

/**
 * The most images one share hands over. The worker keeps only this many, and
 * the upload route accepts a `shared` count up to it (the two must agree, or a
 * bigger share would be dropped as an invalid count).
 */
export const MAX_SHARED_FILES = 100;

/** The header carrying a shared file's name (a cached Response has no filename). */
export const SHARED_NAME_HEADER = "x-shared-name";
