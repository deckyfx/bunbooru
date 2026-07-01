import {
  AuthenticationError,
  AuthorizationError,
  RegistrationConflictError,
  UnsupportedMediaError,
  UploadConflictError,
  UploadRangeError,
  ValidationError,
} from "@bunbooru/core";

import { HttpError } from "./errors";

/**
 * Map an Elysia error/code to an HTTP status. {@link HttpError} carries its own
 * status; Core domain errors map to their semantic status; otherwise known
 * Elysia codes map to standard statuses, defaulting to 500.
 */
export function statusFor(code: string | number, error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof AuthorizationError) return 403;
  if (error instanceof ValidationError) return 400;
  if (error instanceof UnsupportedMediaError) return 415;
  if (error instanceof RegistrationConflictError) return 409;
  if (error instanceof UploadConflictError) return 409;
  if (error instanceof UploadRangeError) return 400;
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
