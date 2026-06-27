import { HttpError } from "./errors";

/**
 * Map an Elysia error/code to an HTTP status. {@link HttpError} carries its own
 * status; otherwise known Elysia codes map to standard statuses, defaulting to
 * 500.
 */
export function statusFor(code: string | number, error: unknown): number {
  if (error instanceof HttpError) return error.status;
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
      return 422;
    case "PARSE":
      return 400;
    default:
      return 500;
  }
}

/** Read the request id stashed on the response headers, if present. */
export function readRequestId(headers: Record<string, unknown>): string | undefined {
  const id = headers["x-request-id"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Client-safe error message: server faults (5xx) are masked outside development
 * so internals never leak; client faults (4xx) keep their explanatory detail.
 */
export function safeMessage(
  status: number,
  detail: string,
  isDevelopment: boolean,
): string {
  return status >= 500 && !isDevelopment ? "Internal Server Error" : detail;
}
