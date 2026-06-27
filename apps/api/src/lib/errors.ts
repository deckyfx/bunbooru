/**
 * Typed HTTP error.
 *
 * Carries an explicit status code so the global error handler can map it to a
 * response without leaking internals. Services/handlers throw this instead of
 * raw strings (per ARCHITECTURE.md: "Errors are typed. Never throw raw strings").
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new Error(`HttpError status must be an integer in 400-599, got ${status}`);
    }
    this.status = status;
  }

  /** Create and throw in one call. */
  static throw(status: number, message: string): never {
    throw new HttpError(status, message);
  }
}
