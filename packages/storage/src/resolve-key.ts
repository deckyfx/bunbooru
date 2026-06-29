import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve `key` to an absolute path strictly inside `root`. Throws on any key
 * that would escape (traversal, absolute path, or the root itself). Uses
 * `relative()` rather than `startsWith(root + sep)` so it stays correct even
 * when `root` is the filesystem root (where `root + sep` would be `//`).
 *
 * Keys are app-generated content paths (e.g. `assets/ab/cd/<sha256>` or an
 * upload token), never raw user input; this confines key-based traversal.
 */
export function resolveKeyWithinRoot(root: string, key: string): string {
  // Reject absolute keys outright: relativizing first would accept an absolute
  // key that happens to point inside root (and always when root === "/").
  if (isAbsolute(key)) {
    throw new Error(`storage key escapes the storage root: ${JSON.stringify(key)}`);
  }
  const full = resolve(root, key);
  const rel = relative(root, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`storage key escapes the storage root: ${JSON.stringify(key)}`);
  }
  return full;
}
