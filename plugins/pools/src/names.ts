import { ValidationError } from "@bunbooru/plugin-sdk";

/** Longest pool name and description accepted. */
export const MAX_POOL_NAME = 100;
export const MAX_POOL_DESCRIPTION = 2000;

/**
 * A pool name in canonical form: trimmed, with runs of whitespace as single
 * underscores (like tags), so `pool:my_comic` can name it in a search, where
 * terms can't contain spaces. A purely numeric name is refused, since
 * `pool:123` always means the pool with id 123. Throws ValidationError.
 */
export function normalizePoolName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, "_");
  if (name.length === 0 || name.length > MAX_POOL_NAME) {
    throw new ValidationError(`A pool name must be 1–${MAX_POOL_NAME} characters`);
  }
  if (/^\d+$/.test(name)) throw new ValidationError("A pool name can't be only digits");
  return name;
}

/** A pool description, trimmed and length-bounded. Throws ValidationError. */
export function normalizeDescription(raw: string): string {
  const description = raw.trim();
  if (description.length > MAX_POOL_DESCRIPTION) {
    throw new ValidationError(`A description is at most ${MAX_POOL_DESCRIPTION} characters`);
  }
  return description;
}
