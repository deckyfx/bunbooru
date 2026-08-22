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
    // In STARTTLS mode (secure=false) nodemailer treats the upgrade as optional
    // and would send cleartext if the server doesn't advertise STARTTLS — which
    // would leak reset/verify tokens. Require the upgrade so a non-TLS server
    // fails the send instead of silently downgrading. (No-op when secure=true.)
    requireTLS: !secrets.secure,
    // Bound every phase so an unreachable/slow/hung SMTP server can't stall the
    // outbox worker's tick indefinitely (a failed send just retries via backoff).
    connectionTimeout: 10_000, // TCP connect
    greetingTimeout: 10_000, // wait for the server's SMTP greeting
    socketTimeout: 30_000, // inactivity mid-conversation
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
