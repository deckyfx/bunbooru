import type { DB, MailProvider, OutgoingMail, PluginLogger } from "@bunbooru/plugin-sdk";

import { maskEmail } from "./mask";
import { enqueue } from "./outbox";
import type { TransportResolver } from "./transport";

/** What the provider needs, resolved once at registration. */
export interface ProviderDeps {
  db: DB;
  log: PluginLogger;
  /** Resolves the current transport from the admin-saved settings (may be log-only). */
  resolver: TransportResolver;
}

/**
 * Build the {@link MailProvider} the host installs on Core's `MailService`.
 *
 * `send()` never dials SMTP inline: with a host configured it ENQUEUES to the
 * outbox and returns (accepted != delivered — the worker drains it). With NO host
 * configured (log-only) it renders the message to the log instead, so mail-
 * dependent flows work with zero config. `isConfigured()` reflects the live
 * setting, so Core's reset/verify flows 503 honestly until an admin sets SMTP up.
 *
 * Logging discipline (doc §6): the recipient is masked and only subject +
 * idempotency key are logged — never the body, tokens, or reset URLs.
 */
export function createMailProvider(deps: ProviderDeps): MailProvider {
  const { db, log, resolver } = deps;

  return {
    async send(mail: OutgoingMail): Promise<void> {
      // No SMTP host configured → log-only: log instead of enqueuing (nothing
      // would ever dial a queued row).
      if (!(await resolver.isConfigured())) {
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
      const transport = await resolver.get();
      // Log-only "works" — mail is captured to the log; nothing to probe.
      if (!transport) return;
      await transport.verify();
    },

    async isConfigured(): Promise<boolean> {
      return resolver.isConfigured();
    },
  };
}
