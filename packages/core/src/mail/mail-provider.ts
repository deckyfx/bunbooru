/**
 * The mail transport contract — Core's dependency-inversion boundary for email,
 * mirroring {@link StorageProvider}. Core defines the interface and depends only
 * on it; a plugin (e.g. `smtp-mailer`) supplies the implementation and registers
 * it through the SDK's `mailProvider`. New transports require zero Core changes.
 *
 * Password reset is the first consumer, but the contract is deliberately
 * transport-only so it outlives that one feature (verification, notifications,
 * digests all reuse it).
 */

/** A message Core asks the active {@link MailProvider} to deliver. */
export interface OutgoingMail {
  /** Recipient address. */
  to: string;
  /** Subject line. */
  subject: string;
  /**
   * Plain-text body. REQUIRED — Core never sends HTML-only mail (a spam-filter
   * magnet and unreadable in text clients).
   */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  /**
   * Stable idempotency key (e.g. `password-reset:<tokenId>`). Providers and the
   * outbox use it to make a retried send at-most-once in practice.
   */
  idempotencyKey: string;
}

/**
 * A mail transport. Implemented by a plugin, held by Core's `MailService`.
 *
 * Note there is intentionally no `from`: the provider owns the envelope sender
 * so Core can't spoof it. No attachments/CC/BCC/templating either — add those
 * only when a real consumer needs them.
 */
export interface MailProvider {
  /**
   * Accept a message for delivery. Resolving means *accepted* (providers queue),
   * not *delivered*. Throwing means permanently rejected (bad address, refused).
   */
  send(mail: OutgoingMail): Promise<void>;
  /** Cheap liveness probe for the admin console (e.g. verify the SMTP connection). */
  verify(): Promise<void>;
  /**
   * Whether the provider is actually usable right now (e.g. an SMTP host has been
   * configured). Optional: a provider that omits it is treated as always
   * configured (e.g. the dev log-only provider). Drives whether Core exposes the
   * self-serve reset/verify flows — a provider that merely exists but isn't set up
   * yet reports `false` here so those endpoints 503 honestly.
   */
  isConfigured?(): boolean | Promise<boolean>;
}
