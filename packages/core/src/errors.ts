/**
 * Core domain errors. Core stays HTTP-agnostic — it throws these typed errors
 * and the API layer maps them to status codes (per ARCHITECTURE.md: errors are
 * typed; never throw raw strings).
 */

/** The uploaded bytes aren't a supported, decodable image. API → 415. */
export class UnsupportedMediaError extends Error {
  constructor(message = "Unsupported or undecodable media type") {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}
