import type { SettingsRepository } from "@bunbooru/db";

import { ValidationError } from "../errors";

/** Setting keys — a DB row overrides the env-derived default for that key. */
const KEY_MAX_UPLOAD = "max_upload_bytes";
const KEY_MAX_RESUMABLE = "max_resumable_upload_bytes";
const KEY_REQUIRE_VERIFIED_EMAIL = "require_verified_email_for_reset";

/** The runtime-editable upload caps (bytes). */
export interface UploadLimits {
  /** One-shot `POST /assets` cap; must stay ≤ the request-body ceiling. */
  maxUploadBytes: number;
  /** Resumable-upload cap; may exceed the request-body ceiling (chunked). */
  maxResumableUploadBytes: number;
}

/** The full set of runtime-editable settings (env defaults merged with DB rows). */
interface ResolvedSettings extends UploadLimits {
  /**
   * Whether self-serve password reset requires a *verified* email. Default false
   * (the UI encourages enabling it): with it off, any stored address can reset;
   * with it on, an unverified address cannot — closing the takeover vector from
   * a mistyped registration email.
   */
  requireVerifiedEmailForReset: boolean;
}

/** Env-derived defaults for all runtime settings, used until a DB row overrides. */
export interface SettingsDefaults extends UploadLimits {
  requireVerifiedEmailForReset: boolean;
}

/** Configuration for {@link createSettingsService}. */
export interface SettingsServiceConfig {
  /** Env-derived defaults, used until (and unless) a DB row overrides them. */
  defaults: SettingsDefaults;
  /** Hard ceiling for the one-shot cap (the HTTP request-body limit). */
  requestBodyCeilingBytes: number;
}

/**
 * Admin-editable runtime settings. The env value seeds each default and a DB row
 * overrides it at runtime. Covers the upload caps and the
 * `require_verified_email_for_reset` policy flag.
 */
export interface SettingsService {
  /** Current caps (env defaults merged with DB overrides), cached in-process. */
  getUploadLimits(): Promise<UploadLimits>;
  /** Validate + persist changed caps, refresh the cache, return the new caps. */
  updateUploadLimits(patch: Partial<UploadLimits>, updatedBy: number | null): Promise<UploadLimits>;
  /** Whether password reset requires a verified email (env default + DB override). */
  getRequireVerifiedEmailForReset(): Promise<boolean>;
  /** Persist the reset-verification policy, refresh the cache, return the new value. */
  setRequireVerifiedEmailForReset(value: boolean, updatedBy: number | null): Promise<boolean>;
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
  // Resolved settings, seeded lazily from DB overrides on first read.
  let cache: ResolvedSettings | null = null;

  /** Parse a stored override to a positive int, else fall back to the default. */
  function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
  }

  /** Parse a stored boolean override (`"true"`/`"false"`), else the default. */
  function parseBool(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  }

  async function load(): Promise<ResolvedSettings> {
    const overrides = await repo.getAll();
    return {
      maxUploadBytes: parsePositiveInt(overrides[KEY_MAX_UPLOAD], defaults.maxUploadBytes),
      maxResumableUploadBytes: parsePositiveInt(
        overrides[KEY_MAX_RESUMABLE],
        defaults.maxResumableUploadBytes,
      ),
      requireVerifiedEmailForReset: parseBool(
        overrides[KEY_REQUIRE_VERIFIED_EMAIL],
        defaults.requireVerifiedEmailForReset,
      ),
    };
  }

  async function current(): Promise<ResolvedSettings> {
    cache ??= await load();
    return cache;
  }

  /** Persist `entries` atomically, then re-read the authoritative DB state. */
  async function persist(
    entries: Array<{ key: string; value: string }>,
    updatedBy: number | null,
  ): Promise<ResolvedSettings> {
    try {
      await repo.setMany(entries, updatedBy);
    } catch (error) {
      cache = null; // drop the (now uncertain) cache so the next read reloads
      throw error;
    }
    // Re-read rather than publishing our optimistic snapshot — so a concurrent
    // admin's write to another key is reflected too (not overwritten by a stale
    // value).
    cache = await load();
    return cache;
  }

  return {
    async getUploadLimits() {
      const { maxUploadBytes, maxResumableUploadBytes } = await current();
      return { maxUploadBytes, maxResumableUploadBytes };
    },

    async updateUploadLimits(patch, updatedBy) {
      const currentLimits = await current();
      const next: UploadLimits = {
        maxUploadBytes: patch.maxUploadBytes ?? currentLimits.maxUploadBytes,
        maxResumableUploadBytes:
          patch.maxResumableUploadBytes ?? currentLimits.maxResumableUploadBytes,
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
      if (entries.length === 0) {
        return { maxUploadBytes: next.maxUploadBytes, maxResumableUploadBytes: next.maxResumableUploadBytes };
      }

      const resolved = await persist(entries, updatedBy);
      return {
        maxUploadBytes: resolved.maxUploadBytes,
        maxResumableUploadBytes: resolved.maxResumableUploadBytes,
      };
    },

    async getRequireVerifiedEmailForReset() {
      return (await current()).requireVerifiedEmailForReset;
    },

    async setRequireVerifiedEmailForReset(value, updatedBy) {
      const resolved = await persist(
        [{ key: KEY_REQUIRE_VERIFIED_EMAIL, value: value ? "true" : "false" }],
        updatedBy,
      );
      return resolved.requireVerifiedEmailForReset;
    },
  };
}
