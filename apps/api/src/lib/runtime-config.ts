import { envConfig } from "../env-config";

/**
 * Where a setting's effective value came from. `default` means the variable was
 * never set and a built-in applies; `database` means an admin overrode the env
 * value at runtime, so the env value is a seed rather than the truth.
 */
export type SettingSource = "env" | "default" | "database";

/** One runtime setting as shown on the admin page. */
export interface RuntimeSetting {
  /** Env variable name, or a descriptive key for values with no variable. */
  key: string;
  /** Effective value, MASKED when {@link secret}. Null when genuinely unset. */
  value: string | null;
  source: SettingSource;
  /** Whether {@link value} has been redacted — the UI says so rather than implying it's literal. */
  secret: boolean;
  /** Short operator-facing note (units, consequences, gotchas). */
  note?: string;
}

/** A titled group of settings, in display order. */
export interface RuntimeSection {
  title: string;
  settings: RuntimeSetting[];
}

/** `env` when the variable is set to a non-empty value, else `default`. */
function sourceOf(key: string): SettingSource {
  const raw = Bun.env[key];
  return raw !== undefined && raw.trim() !== "" ? "env" : "default";
}

/**
 * Redact the password from a connection URL, keeping everything an operator
 * needs to diagnose (scheme, user, host, port, database).
 *
 * `postgres://bunbooru:hunter2@localhost:5432/bunbooru`
 *   → `postgres://bunbooru:***@localhost:5432/bunbooru`
 *
 * Falls back to a total redaction if the value doesn't parse — better an opaque
 * value than accidentally echoing a secret because it was malformed.
 */
export function maskConnectionUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.password) return raw;
    url.password = "***";
    // URL serialization percent-encodes the mask; put it back verbatim so the
    // display reads as an obvious placeholder rather than "%2A%2A%2A".
    return url.toString().replace("%2A%2A%2A", "***");
  } catch {
    return "***";
  }
}

/** Human byte size (binary units) for the upload caps. */
function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]} (${n.toLocaleString("en-US")} bytes)`;
}

/** Human duration for the millisecond settings. */
function duration(ms: number): string {
  if (ms === 0) return "0 (disabled)";
  const hours = ms / 3_600_000;
  if (hours >= 24) return `${Math.round((hours / 24) * 10) / 10} days`;
  if (hours >= 1) return `${Math.round(hours * 10) / 10} hours`;
  return `${Math.round(ms / 60_000)} minutes`;
}

/** Inputs the describer can't read from the environment itself. */
export interface RuntimeConfigInput {
  /** Effective mail-link origin (env value, or the composition root's dev fallback). */
  publicBaseUrl: string | null;
  /** Current upload caps AFTER any admin override. */
  uploadLimits: { maxUploadBytes: number; maxResumableUploadBytes: number };
  /** Current reset policy AFTER any admin override. */
  requireVerifiedEmailForReset: boolean;
  /** Plugin id providing the active mail transport, or null. */
  mailProviderId: string | null;
  /** Whether mail is actually usable right now. */
  mailConfigured: boolean;
  /** `<active>/<installed>` plugin counts. */
  plugins: { installed: number; active: number };
}

/**
 * Describe the server's effective runtime configuration for the admin console.
 *
 * READ-ONLY by design: almost everything here is environment, fixed before boot,
 * so there is nothing to write. Its job is to answer "what is this server
 * actually using?" without an operator shelling in to read `.env` — the question
 * that otherwise gets answered by guessing.
 *
 * Secrets are never returned verbatim. Values that embed credentials are masked
 * here, at the source, rather than in the UI, so a future caller of this function
 * cannot accidentally leak them.
 */
export function describeRuntimeConfig(input: RuntimeConfigInput): RuntimeSection[] {
  const {
    publicBaseUrl,
    uploadLimits,
    requireVerifiedEmailForReset,
    mailProviderId,
    mailConfigured,
    plugins,
  } = input;

  const envUploadCap = envConfig.MAX_UPLOAD_BYTES;
  const envResumableCap = envConfig.MAX_RESUMABLE_UPLOAD_BYTES;

  return [
    {
      title: "Server",
      settings: [
        { key: "NODE_ENV", value: envConfig.NODE_ENV, source: sourceOf("NODE_ENV"), secret: false },
        {
          key: "SERVER_PORT",
          value: String(envConfig.SERVER_PORT),
          source: sourceOf("SERVER_PORT"),
          secret: false,
        },
        {
          key: "LOG_FORMAT",
          value: envConfig.LOG_FORMAT,
          source: sourceOf("LOG_FORMAT"),
          secret: false,
          note: "Defaults to pretty in development, json otherwise.",
        },
        {
          key: "TRUST_PROXY",
          value: String(envConfig.TRUST_PROXY),
          source: sourceOf("TRUST_PROXY"),
          secret: false,
          note: "Only enable behind a proxy that sets X-Forwarded-For — otherwise clients can spoof the rate-limit key.",
        },
        {
          key: "COOKIE_SECURE",
          value: String(envConfig.COOKIE_SECURE),
          source: sourceOf("COOKIE_SECURE"),
          secret: false,
          note: "Session cookies are HTTPS-only when true.",
        },
      ],
    },
    {
      title: "Database & storage",
      settings: [
        {
          key: "DATABASE_URL",
          value: maskConnectionUrl(envConfig.DATABASE_URL),
          source: sourceOf("DATABASE_URL"),
          secret: true,
        },
        {
          key: "DB_POOL_MAX",
          value: Bun.env.DB_POOL_MAX?.trim() || "10",
          source: sourceOf("DB_POOL_MAX"),
          secret: false,
          note: "Maximum pooled Postgres connections per handle.",
        },
        {
          key: "STORAGE_ROOT",
          value: envConfig.STORAGE_ROOT,
          source: sourceOf("STORAGE_ROOT"),
          secret: false,
          note: "Moving this after uploads exist means migrating the stored blobs.",
        },
      ],
    },
    {
      title: "Uploads",
      settings: [
        {
          key: "MAX_UPLOAD_BYTES",
          value: bytes(uploadLimits.maxUploadBytes),
          // The env value only seeds the default; an admin override in the DB wins.
          source: uploadLimits.maxUploadBytes === envUploadCap ? sourceOf("MAX_UPLOAD_BYTES") : "database",
          secret: false,
          note: "One-shot POST /assets cap. Editable at runtime below.",
        },
        {
          key: "MAX_RESUMABLE_UPLOAD_BYTES",
          value: bytes(uploadLimits.maxResumableUploadBytes),
          source:
            uploadLimits.maxResumableUploadBytes === envResumableCap
              ? sourceOf("MAX_RESUMABLE_UPLOAD_BYTES")
              : "database",
          secret: false,
          note: "Resumable chunked-upload cap. Editable at runtime below.",
        },
      ],
    },
    {
      title: "Sessions",
      settings: [
        {
          key: "SESSION_EXPIRY_MS",
          value: duration(envConfig.SESSION_EXPIRY_MS),
          source: sourceOf("SESSION_EXPIRY_MS"),
          secret: false,
        },
        {
          key: "SESSION_GC_INTERVAL_MS",
          value: duration(envConfig.SESSION_GC_INTERVAL_MS),
          source: sourceOf("SESSION_GC_INTERVAL_MS"),
          secret: false,
        },
      ],
    },
    {
      title: "Mail & password reset",
      settings: [
        {
          key: "PUBLIC_BASE_URL",
          value: publicBaseUrl,
          source: sourceOf("PUBLIC_BASE_URL"),
          secret: false,
          note: "Origin of every link in outgoing email. Must address the WEB server, never the API port.",
        },
        {
          key: "Mail provider",
          value: mailProviderId
            ? `${mailProviderId}${mailConfigured ? "" : " (installed but not configured)"}`
            : null,
          source: "default",
          secret: false,
          note: mailConfigured
            ? undefined
            : "Password reset and email verification return 503 until a provider is active and configured.",
        },
        {
          key: "REQUIRE_VERIFIED_EMAIL_FOR_RESET",
          value: String(requireVerifiedEmailForReset),
          source:
            requireVerifiedEmailForReset === envConfig.REQUIRE_VERIFIED_EMAIL_FOR_RESET
              ? sourceOf("REQUIRE_VERIFIED_EMAIL_FOR_RESET")
              : "database",
          secret: false,
        },
      ],
    },
    {
      title: "Plugins",
      settings: [
        {
          key: "ENABLED_PLUGINS",
          value: envConfig.ENABLED_PLUGINS.join(", ") || null,
          source: sourceOf("ENABLED_PLUGINS"),
          secret: false,
          note: "Seeds the active set on FIRST boot only — afterwards the admin console is the source of truth.",
        },
        {
          key: "Active plugins",
          value: `${plugins.active} of ${plugins.installed} installed`,
          source: "database",
          secret: false,
        },
      ],
    },
  ];
}
