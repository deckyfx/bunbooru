import { resolve } from "node:path";

/**
 * Hard ceiling for the HTTP request body (2 GiB). The per-upload policy
 * (`MAX_UPLOAD_BYTES`) must stay at or below this — enforced in the getter so a
 * bad env value fails fast at startup rather than silently at the server layer.
 */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Largest delay a `setInterval`/`setTimeout` accepts (2^31 − 1 ms, ~24.8 days).
 * Node and Bun truncate a larger delay to a 32-bit int, so it can wrap to a tiny
 * value and fire almost immediately — a timer interval must be capped to this.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Typed, singleton access to the API's environment configuration.
 *
 * Runtime values (host, port, credentials) are read here — never baked into
 * the production build — so the same binary runs in any environment.
 */
class EnvConfig {
  private static instance: EnvConfig;

  private constructor() {}

  /** Shared singleton instance. */
  static getInstance(): EnvConfig {
    if (!EnvConfig.instance) {
      EnvConfig.instance = new EnvConfig();
    }
    return EnvConfig.instance;
  }

  /** HTTP port the API listens on (default 3000). Throws on an invalid value. */
  get SERVER_PORT(): number {
    const raw = Bun.env.SERVER_PORT;
    if (raw === undefined || raw === "") return 3000;

    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `SERVER_PORT must be an integer between 1 and 65535, got "${raw}"`,
      );
    }
    return port;
  }

  /**
   * Postgres connection string. Required: the API cannot serve data without it,
   * so a missing value fails fast at startup rather than on the first query.
   */
  get DATABASE_URL(): string {
    // Trim so a whitespace-only value fails fast here rather than deeper in the
    // driver when it tries to parse the connection string.
    const url = Bun.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error("DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)");
    }
    return url;
  }

  /**
   * Filesystem root for stored asset binaries. Required in production; in dev it
   * defaults to an **absolute** `<cwd>/data/storage`, keeping uploaded images on
   * the host under the project's `data/` dir (alongside the db/redis mounts).
   *
   * `data/` is created root-owned by the Docker bind mounts, so the dir must be
   * made writable by the app user once: `sudo install -d -o "$USER" -g "$USER" data/storage`.
   */
  get STORAGE_ROOT(): string {
    const raw = Bun.env.STORAGE_ROOT?.trim();
    if (raw) return raw;
    if (this.NODE_ENV === "production") {
      throw new Error("STORAGE_ROOT is required outside development");
    }
    return resolve(process.cwd(), "data/storage");
  }

  /**
   * Max accepted upload size in bytes (default 100 MB). Larger uploads are
   * rejected with 413 and logged. Must stay at or below {@link MAX_REQUEST_BODY_BYTES}.
   */
  get MAX_UPLOAD_BYTES(): number {
    const raw = Bun.env.MAX_UPLOAD_BYTES;
    if (raw === undefined || raw === "") return 100 * 1024 * 1024;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`MAX_UPLOAD_BYTES must be a positive integer, got "${raw}"`);
    }
    if (n > MAX_REQUEST_BODY_BYTES) {
      throw new Error(
        `MAX_UPLOAD_BYTES (${n}) cannot exceed the request-body ceiling (${MAX_REQUEST_BODY_BYTES})`,
      );
    }
    return n;
  }

  /**
   * How often (ms) to sweep expired resumable-upload sessions and their staging
   * files (default 15 min). `0` disables the periodic sweep — sessions are then
   * only reclaimed opportunistically when the next upload begins.
   */
  get UPLOAD_GC_INTERVAL_MS(): number {
    const raw = Bun.env.UPLOAD_GC_INTERVAL_MS;
    if (raw === undefined || raw === "") return 15 * 60 * 1000;
    const n = Number(raw);
    // Cap at the timer ceiling: a larger setInterval delay wraps to a 32-bit int
    // and can fire almost immediately — the opposite of the intended long sweep.
    if (!Number.isInteger(n) || n < 0 || n > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `UPLOAD_GC_INTERVAL_MS must be an integer between 0 and ${MAX_TIMER_DELAY_MS}, got "${raw}"`,
      );
    }
    return n;
  }

  /**
   * Runtime environment mode. Fails closed: an unset value defaults to
   * "production" so a missing variable never accidentally enables dev-only
   * behavior (e.g. leaking 5xx detail). Unsupported values are rejected.
   */
  get NODE_ENV(): "development" | "production" | "test" {
    const env = Bun.env.NODE_ENV ?? "production";
    if (env !== "development" && env !== "production" && env !== "test") {
      throw new Error(
        `NODE_ENV must be one of "development", "production", "test", got "${env}"`,
      );
    }
    return env;
  }

  /** Whether the API is running in development mode (only when explicitly set). */
  get isDevelopment(): boolean {
    return this.NODE_ENV === "development";
  }
}

export const envConfig = EnvConfig.getInstance();
