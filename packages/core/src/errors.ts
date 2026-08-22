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

/** Not authenticated (no/invalid session) or bad credentials. API → 401. */
export class AuthenticationError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** Authenticated, but not permitted to perform the action. API → 403. */
export class AuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Registration hit a unique conflict (username/email already taken). API → 409. */
export class RegistrationConflictError extends Error {
  constructor(message = "Username or email already taken") {
    super(message);
    this.name = "RegistrationConflictError";
  }
}

/** Invalid input that passed HTTP-schema shape but failed a domain rule. API → 400. */
export class ValidationError extends Error {
  constructor(message = "Invalid input") {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * A mail-dependent operation (send/verify) was attempted while no
 * {@link MailProvider} is registered. The API maps this to 503 — the feature is
 * unconfigured, not the request malformed. Callers can pre-check
 * `mailService.isConfigured()` to avoid triggering it.
 */
export class MailNotConfiguredError extends Error {
  constructor(message = "Mail delivery is not configured") {
    super(message);
    this.name = "MailNotConfiguredError";
  }
}

/**
 * Two different plugins tried to register a {@link MailProvider}. Fails fast
 * (naming both plugin ids) rather than silently last-wins, which would send mail
 * out an unintended transport. Thrown at boot by the composition root. API → 500
 * if it ever surfaced at request time (it shouldn't — it's a startup error).
 */
export class MailProviderConflictError extends Error {
  constructor(
    /** The plugin that already owns the active provider. */
    readonly existingPluginId: string,
    /** The plugin that attempted to replace it. */
    readonly incomingPluginId: string,
  ) {
    super(
      `Mail provider already registered by plugin "${existingPluginId}"; ` +
        `plugin "${incomingPluginId}" cannot register a second one`,
    );
    this.name = "MailProviderConflictError";
  }
}
