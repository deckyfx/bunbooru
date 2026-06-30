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

/** A chunk's declared offset doesn't match the session's current offset. API → 409. */
export class UploadConflictError extends Error {
  constructor(message = "Upload offset does not match the session") {
    super(message);
    this.name = "UploadConflictError";
  }
}

/** A chunk would push the upload past its declared size, or the session is unknown. API → 400. */
export class UploadRangeError extends Error {
  constructor(message = "Upload chunk is out of range") {
    super(message);
    this.name = "UploadRangeError";
  }
}
