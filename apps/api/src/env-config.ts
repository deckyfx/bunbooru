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
