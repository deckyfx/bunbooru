// nodemailer is a justified deviation from the Bun-native preference: Bun has no
// native SMTP client, and the alternative (hand-rolling SMTP + STARTTLS/auth/
// pooling with TLS) is strictly worse. See docs §6.
import { createTransport } from "nodemailer";

import type { DB } from "@bunbooru/plugin-sdk";

import { secretsFromSettings, type SmtpSecrets } from "./config";
import { getMailSettings, type MailSettings } from "./settings";

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
  /** Release the pooled connections (on settings change / shutdown). */
  close(): Promise<void>;
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
    async close() {
      // nodemailer's close() is synchronous; wrapped for a uniform async contract.
      transporter.close();
    },
  };
}

/**
 * Resolves the current {@link SmtpTransport} from the admin-saved settings,
 * rebuilding (and closing the old one) only when the connection tuple changes —
 * so saving new SMTP settings in the UI takes effect on the next send without a
 * restart. Returns `null` when no host is configured (log-only mode).
 */
export interface TransportResolver {
  /**
   * The current transport, or `null` if no SMTP host is configured. Pass an
   * already-read `settings` snapshot to resolve against it (so a single drain
   * uses ONE consistent view of settings); omit it to read fresh.
   */
  get(settings?: MailSettings): Promise<SmtpTransport | null>;
  /** Whether an SMTP host is currently configured (drives log-only vs SMTP). */
  isConfigured(): Promise<boolean>;
  /** Close the cached transport, if any (shutdown). */
  close(): Promise<void>;
}

/** Build a {@link TransportResolver} over the plugin's DB handle. */
export function createTransportResolver(db: DB): TransportResolver {
  let cached: { key: string; transport: SmtpTransport } | null = null;

  // Serialize the cache lifecycle: get()/close() run one-at-a-time so two
  // concurrent callers during a credential change can't each build a transport
  // (leaking one) or close the same one twice. isConfigured() only reads settings
  // and never touches the cache, so it stays outside the lock.
  let lock: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  const keyOf = (s: SmtpSecrets): string =>
    JSON.stringify([s.host, s.port, s.secure, s.user ?? null, s.password ?? null]);

  return {
    get(settings?: MailSettings) {
      return serialize(async () => {
        const secrets = secretsFromSettings(settings ?? (await getMailSettings(db)));
        if (!secrets) {
          if (cached) {
            await cached.transport.close();
            cached = null;
          }
          return null;
        }
        const key = keyOf(secrets);
        if (cached && cached.key === key) return cached.transport;
        // DECISION (re: CodeRabbit "lease the cached transport"): we do NOT
        // refcount active senders and defer this close. If an admin changes SMTP
        // settings mid-drain, an in-flight send on the old transport may error —
        // but that's a single RETRIABLE failure (the outbox retries with backoff;
        // no loss, no duplicate), and the window is narrow (a ~15s-interval drain
        // overlapping a rare settings change). A per-send lease + deferred close is
        // over-engineering for a bounded, self-healing case at this stage.
        if (cached) await cached.transport.close();
        cached = { key, transport: createNodemailerTransport(secrets) };
        return cached.transport;
      });
    },

    async isConfigured() {
      return secretsFromSettings(await getMailSettings(db)) !== null;
    },

    close() {
      return serialize(async () => {
        if (cached) {
          await cached.transport.close();
          cached = null;
        }
      });
    },
  };
}
