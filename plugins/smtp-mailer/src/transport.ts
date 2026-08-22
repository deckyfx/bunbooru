// nodemailer is a justified deviation from the Bun-native preference: Bun has no
// native SMTP client, and the alternative (hand-rolling SMTP + STARTTLS/auth/
// pooling with TLS) is strictly worse. See docs §6.
import { createTransport } from "nodemailer";

import type { SmtpSecrets } from "./config";

/** One message the transport dials out, with its resolved envelope sender. */
export interface OutgoingSmtpMessage {
  /** Composed envelope sender (`"Name" <addr>` or bare address). */
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

/**
 * The SMTP transport the outbox worker drives. An interface (not the raw
 * nodemailer type) so the worker and provider can be tested against a stub.
 */
export interface SmtpTransport {
  /** Dial SMTP and hand off one message. Throws on a delivery failure. */
  send(message: OutgoingSmtpMessage): Promise<void>;
  /** Probe the SMTP connection (auth + reachability). Throws when unreachable. */
  verify(): Promise<void>;
}

/**
 * Build an {@link SmtpTransport} backed by a pooled nodemailer transporter.
 * Pooling reuses connections across the outbox worker's sends rather than
 * dialing per message.
 */
export function createNodemailerTransport(secrets: SmtpSecrets): SmtpTransport {
  const transporter = createTransport({
    host: secrets.host,
    port: secrets.port,
    secure: secrets.secure,
    auth: secrets.user ? { user: secrets.user, pass: secrets.password } : undefined,
    pool: true,
  });

  return {
    async send(message) {
      await transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
      });
    },
    async verify() {
      await transporter.verify();
    },
  };
}
