import type { DB, MailProvider, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { maskEmail } from "./mask";
import { enqueue } from "./outbox";
import type { SmtpTransport } from "./transport";

/** What the provider needs, resolved once at registration. */
export interface ProviderDeps {
  db: DB;
  log: PluginLogger;
  /**
   * The SMTP transport, or `null` for log-only mode (no SMTP host configured).
   * In log-only mode `send()` logs instead of enqueuing/dialing.
   */
  transport: SmtpTransport | null;
}

/**
 * Build the {@link MailProvider} the host installs on Core's `MailService`.
 *
 * `send()` never dials SMTP inline: it ENQUEUES to the outbox and returns
 * (accepted != delivered — the worker drains it). In log-only mode it renders
 * the message to the log instead, so mail-dependent flows work with zero config.
 *
 * Logging discipline (doc §6): the recipient is masked and only subject +
 * idempotency key are logged — never the body, tokens, or reset URLs.
 */
export function createMailProvider(deps: ProviderDeps): MailProvider {
  const { db, log, transport } = deps;
  const logOnly = transport === null;

  return {
    async send(mail: OutgoingMail): Promise<void> {
      if (logOnly) {
        log.info("mail_log_only", {
          to: maskEmail(mail.to),
          subject: mail.subject,
          idempotencyKey: mail.idempotencyKey,
        });
        return;
      }
      const inserted = await enqueue(db, mail);
      log.info("mail_enqueued", {
        to: maskEmail(mail.to),
        subject: mail.subject,
        idempotencyKey: mail.idempotencyKey,
        duplicate: !inserted,
      });
    },

    async verify(): Promise<void> {
      // Log-only "works" — mail is captured to the log; nothing to probe.
      if (logOnly) return;
      await transport.verify();
    },
  };
}
