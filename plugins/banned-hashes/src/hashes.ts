import { ValidationError } from "@bunbooru/plugin-sdk";

/** What a ban names: a sha256, an md5, or both. */
export interface BanHashes {
  sha256: string | null;
  md5: string | null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MD5_RE = /^[0-9a-f]{32}$/;

/**
 * Normalize moderator input to lowercase hex, rejecting anything that isn't a
 * well-formed hash. At least one is required.
 */
export function normalizeHashes(input: { sha256?: string | null; md5?: string | null }): BanHashes {
  const sha256 = input.sha256?.trim().toLowerCase() || null;
  const md5 = input.md5?.trim().toLowerCase() || null;
  if (sha256 !== null && !SHA256_RE.test(sha256)) throw new ValidationError("sha256 must be 64 hex characters");
  if (md5 !== null && !MD5_RE.test(md5)) throw new ValidationError("md5 must be 32 hex characters");
  if (sha256 === null && md5 === null) throw new ValidationError("Give a sha256, an md5, or a post");
  return { sha256, md5 };
}

/** The uploader-facing refusal for a banned file. */
export function refusalReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed ? `This file is banned: ${trimmed}` : "This file is banned";
}
