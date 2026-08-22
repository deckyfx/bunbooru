import { MailNotConfiguredError, MailProviderConflictError } from "../errors";
import type { MailProvider, OutgoingMail } from "./mail-provider";

/**
 * Core's mail hub. Holds at most one active {@link MailProvider} (supplied by a
 * plugin via the SDK) behind a stable interface every Core consumer — password
 * reset, email verification, future notifications — sends through. The provider
 * is mutable so it can be installed after Core assembly (plugins load later) and
 * swapped in tests, but a *second, different* plugin trying to claim it fails
 * fast rather than silently rerouting mail.
 */
export interface MailService {
  /**
   * Whether mail is actually usable right now — a provider is installed AND (if it
   * reports readiness) it's configured. Async because a provider may need to check
   * runtime config (e.g. an SMTP host saved in the DB). Gates the reset/verify flows.
   */
  isConfigured(): Promise<boolean>;
  /** The id of the plugin that installed the active provider, or null (sync). */
  activeProviderId(): string | null;
  /**
   * Install `provider`, attributing it to `pluginId`. Re-installing from the SAME
   * plugin id replaces it (idempotent reload); a DIFFERENT plugin id throws
   * {@link MailProviderConflictError}.
   */
  setProvider(provider: MailProvider, pluginId: string): void;
  /**
   * Hand a message to the active provider. Throws {@link MailNotConfiguredError}
   * when none is installed. Resolving means *accepted*, not *delivered*.
   */
  send(mail: OutgoingMail): Promise<void>;
  /**
   * Liveness probe against the active provider (e.g. verify the SMTP connection).
   * Throws {@link MailNotConfiguredError} when none is installed.
   */
  verify(): Promise<void>;
}

/** Build an empty {@link MailService}; a provider is installed later via `setProvider`. */
export function createMailService(): MailService {
  let active: { provider: MailProvider; pluginId: string } | null = null;

  return {
    async isConfigured() {
      if (!active) return false;
      // A provider without an isConfigured() hook is treated as ready (e.g. the
      // dev log-only provider); one with it defers to its runtime check.
      return (await active.provider.isConfigured?.()) ?? true;
    },

    activeProviderId() {
      return active?.pluginId ?? null;
    },

    setProvider(provider, pluginId) {
      if (active && active.pluginId !== pluginId) {
        throw new MailProviderConflictError(active.pluginId, pluginId);
      }
      active = { provider, pluginId };
    },

    async send(mail) {
      if (!active) throw new MailNotConfiguredError();
      await active.provider.send(mail);
    },

    async verify() {
      if (!active) throw new MailNotConfiguredError();
      await active.provider.verify();
    },
  };
}

/** Minimal structured logger shape {@link createLogMailProvider} writes to. */
export interface MailLogger {
  info(message: string, data?: Record<string, unknown>): void;
}

/**
 * Mask a recipient address for logging — keeps a plain user identifier out of
 * logs by default. `alice@example.com` → `a***e@example.com`; a short local part
 * → `***@domain`; a value with no `@` is fully masked. Mirrors the smtp-mailer
 * plugin's masking so both mail log paths behave identically.
 */
function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  // No local part, or no domain (`alice@`) → fully opaque.
  if (at <= 0 || at === address.length - 1) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length <= 2) return `***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * A development/testing {@link MailProvider} that logs each message instead of
 * sending it — so the reset/verify flows are exercisable end-to-end with zero
 * mail configuration. Installed automatically outside production when no real
 * provider is registered. Never logs the message body (it can contain a live
 * token); only the MASKED recipient, subject, and idempotency key are recorded.
 */
export function createLogMailProvider(log: MailLogger): MailProvider {
  return {
    async send(mail) {
      log.info("mail_log_provider_send", {
        to: maskEmail(mail.to),
        subject: mail.subject,
        idempotencyKey: mail.idempotencyKey,
      });
    },
    async verify() {
      // A log provider is always "reachable".
    },
  };
}
