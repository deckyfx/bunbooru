/**
 * Plain-text templates for the authentication emails Core sends (reset,
 * verification). The locked {@link MailProvider} contract is transport-only (it
 * takes a fully-rendered {@link OutgoingMail}), so Core renders the wording here
 * rather than passing structured data to the plugin. Kept deliberately minimal —
 * plain text first, no HTML, no template engine until a real need appears.
 */

/** A rendered message body (subject + plain text) for {@link OutgoingMail}. */
export interface RenderedMail {
  subject: string;
  text: string;
}

/** The password-reset email: the reset link, its expiry, and a safety note. */
export function renderPasswordResetMail(link: string, expiryMinutes: number): RenderedMail {
  return {
    subject: "Reset your bunbooru password",
    text: [
      "Someone requested a password reset for your bunbooru account.",
      "",
      "To choose a new password, open this link:",
      link,
      "",
      `This link expires in ${expiryMinutes} minutes and can be used once.`,
      "",
      "If you didn't request this, you can ignore this email — your password",
      "is unchanged.",
    ].join("\n"),
  };
}

/** The email-verification message: the confirm link and its expiry. */
export function renderEmailVerificationMail(link: string, expiryMinutes: number): RenderedMail {
  return {
    subject: "Verify your bunbooru email address",
    text: [
      "Confirm this email address for your bunbooru account by opening this link:",
      link,
      "",
      `This link expires in ${expiryMinutes} minutes and can be used once.`,
      "",
      "If you didn't request this, you can ignore this email.",
    ].join("\n"),
  };
}
