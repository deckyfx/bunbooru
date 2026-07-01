import type { SettingsRepository } from "@bunbooru/db";

import { ValidationError } from "../errors";

/** Setting keys — a DB row overrides the env-derived default for that key. */
const KEY_MAX_UPLOAD = "max_upload_bytes";
const KEY_MAX_RESUMABLE = "max_resumable_upload_bytes";

/** The runtime-editable upload caps (bytes). */
export interface UploadLimits {
  /** One-shot `POST /assets` cap; must stay ≤ the request-body ceiling. */
  maxUploadBytes: number;
  /** Resumable-upload cap; may exceed the request-body ceiling (chunked). */
  maxResumableUploadBytes: number;
}

/** Configuration for {@link createSettingsService}. */
export interface SettingsServiceConfig {
  /** Env-derived defaults, used until (and unless) a DB row overrides them. */
  defaults: UploadLimits;
  /** Hard ceiling for the one-shot cap (the HTTP request-body limit). */
  requestBodyCeilingBytes: number;
}

/**
 * Admin-editable runtime settings. Only the upload caps are editable for now;
 * the env value seeds the default and a DB row overrides it at runtime.
 */
export interface SettingsService {
  /** Current caps (env defaults merged with DB overrides), cached in-process. */
  getUploadLimits(): Promise<UploadLimits>;
  /** Validate + persist changed caps, refresh the cache, return the new caps. */
  updateUploadLimits(patch: Partial<UploadLimits>, updatedBy: number | null): Promise<UploadLimits>;
}

/**
 * Build a {@link SettingsService}. Deployment is single-instance, so the
 * in-memory cache is authoritative — writes refresh it directly and no
 * cross-process invalidation is needed.
 */
export function createSettingsService(
  repo: SettingsRepository,
  { defaults, requestBodyCeilingBytes }: SettingsServiceConfig,
): SettingsService {
  // Resolved caps, seeded lazily from DB overrides on first read.
  let cache: UploadLimits | null = null;

  /** Parse a stored override to a positive int, else fall back to the default. */
  function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
  }

  async function load(): Promise<UploadLimits> {
    const overrides = await repo.getAll();
    return {
      maxUploadBytes: parsePositiveInt(overrides[KEY_MAX_UPLOAD], defaults.maxUploadBytes),
      maxResumableUploadBytes: parsePositiveInt(
        overrides[KEY_MAX_RESUMABLE],
        defaults.maxResumableUploadBytes,
      ),
    };
  }

  async function currentLimits(): Promise<UploadLimits> {
    cache ??= await load();
    return cache;
  }

  return {
    getUploadLimits: currentLimits,

    async updateUploadLimits(patch, updatedBy) {
      const current = await currentLimits();
      const next: UploadLimits = {
        maxUploadBytes: patch.maxUploadBytes ?? current.maxUploadBytes,
        maxResumableUploadBytes: patch.maxResumableUploadBytes ?? current.maxResumableUploadBytes,
      };

      if (!Number.isSafeInteger(next.maxUploadBytes) || next.maxUploadBytes < 1) {
        throw new ValidationError("maxUploadBytes must be a positive integer");
      }
      if (next.maxUploadBytes > requestBodyCeilingBytes) {
        throw new ValidationError(
          `maxUploadBytes cannot exceed the request-body ceiling (${requestBodyCeilingBytes})`,
        );
      }
      // The resumable cap is intentionally NOT bounded by the request-body
      // ceiling — resumable uploads arrive in chunks and may exceed it.
      if (!Number.isSafeInteger(next.maxResumableUploadBytes) || next.maxResumableUploadBytes < 1) {
        throw new ValidationError("maxResumableUploadBytes must be a positive integer");
      }

      const entries: Array<{ key: string; value: string }> = [];
      if (patch.maxUploadBytes !== undefined) {
        entries.push({ key: KEY_MAX_UPLOAD, value: String(next.maxUploadBytes) });
      }
      if (patch.maxResumableUploadBytes !== undefined) {
        entries.push({ key: KEY_MAX_RESUMABLE, value: String(next.maxResumableUploadBytes) });
      }
      if (entries.length === 0) return current; // nothing to change

      try {
        await repo.setMany(entries, updatedBy);
      } catch (error) {
        cache = null; // drop the (now uncertain) cache so the next read reloads
        throw error;
      }
      // Re-read the authoritative DB state rather than publishing our optimistic
      // snapshot — so a concurrent admin's write to the OTHER key is reflected
      // too (not overwritten by our stale value).
      cache = await load();
      return cache;
    },
  };
}
