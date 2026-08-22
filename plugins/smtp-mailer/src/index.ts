import { fileURLToPath } from "node:url";

import { Elysia, t } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  definePlugin,
  pluginRoutePrefix,
  type MailProvider,
  type PluginContext,
} from "@bunbooru/plugin-sdk";

import { readSmtpSecrets } from "./config";
import { outboxCounts } from "./outbox";
import { createMailProvider } from "./provider";
import { getMailSettings, updateMailSettings } from "./settings";
import { createNodemailerTransport, type SmtpTransport } from "./transport";
import { startWorker } from "./worker";

/** This plugin's stable id — route-prefix segment + migrations-table suffix. */
const PLUGIN_ID = "smtp-mailer";

/** Assert the caller is an admin/moderator (401 anonymous / 403 otherwise). */
async function requireAdmin(ctx: PluginContext, request: Request): Promise<void> {
  const user = await ctx.auth.currentUser(request);
  if (!user) throw new AuthenticationError();
  if (!canModerate(user)) throw new AuthorizationError();
}

/** Deps the routes close over, resolved once in `register`. */
interface RouteDeps {
  provider: MailProvider;
  /** The live transport, or null in log-only mode. */
  transport: SmtpTransport | null;
}

/**
 * Build the smtp-mailer's admin HTTP routes. Extracted so its return TYPE drives
 * a typed Eden client on the web ({@link SmtpMailerPluginApp}). Prefixed with
 * {@link pluginRoutePrefix} so paths resolve under `/api/v1/plugins/smtp-mailer`.
 *
 * SECRETS ARE NEVER RETURNED HERE — only the mode (smtp vs log-only), the
 * connection probe result, non-secret settings, and outbox counts.
 */
export function buildSmtpMailerRoutes(ctx: PluginContext, deps: RouteDeps) {
  const mode = deps.transport ? ("smtp" as const) : ("log-only" as const);
  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    // Connection status + non-secret settings + outbox counts (admin-only).
    .get("/status", async ({ request }) => {
      await requireAdmin(ctx, request);
      let verified = false;
      // Named `probeError` (not `error`) so the web's `unwrap` envelope helper —
      // which strips any `{ error: unknown }` shape — doesn't collapse this body.
      let probeError: string | null = null;
      try {
        // Probe the transport directly (log-only reports verified with no dial).
        if (deps.transport) await deps.transport.verify();
        verified = true;
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }
      const settings = await getMailSettings(ctx.db);
      const outbox = await outboxCounts(ctx.db);
      return { mode, verified, probeError, settings, outbox };
    })
    // Update the non-secret operational settings (admin-only).
    .put(
      "/settings",
      async ({ request, body }) => {
        await requireAdmin(ctx, request);
        // Pass omitted fields through UNCHANGED (updateMailSettings preserves keys
        // that are `undefined`); an explicit `null` clears a field. Coercing
        // omitted → null would wipe fromAddress on an enabled-only toggle and stall
        // the outbox.
        return updateMailSettings(ctx.db, {
          enabled: body.enabled,
          ...(body.fromName !== undefined ? { fromName: body.fromName } : {}),
          ...(body.fromAddress !== undefined ? { fromAddress: body.fromAddress } : {}),
          ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
        });
      },
      {
        body: t.Object({
          // Nullable so a client can distinguish "leave unchanged" (omit) from
          // "clear this field" (explicit null).
          fromName: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
          fromAddress: t.Optional(t.Union([t.String({ format: "email", maxLength: 320 }), t.Null()])),
          replyTo: t.Optional(t.Union([t.String({ format: "email", maxLength: 320 }), t.Null()])),
          enabled: t.Boolean(),
        }),
      },
    )
    // Send a test email (admin-only) — the highest-value feature: it surfaces an
    // SMTP misconfiguration here instead of on a user's silently-failed reset.
    // Goes through the provider (enqueue → worker), so it exercises the real path.
    .post(
      "/test",
      async ({ request, body }) => {
        await requireAdmin(ctx, request);
        await deps.provider.send({
          to: body.to,
          subject: "Bunbooru SMTP test",
          text:
            "This is a test message from your Bunbooru instance's smtp-mailer plugin.\n" +
            "If you received it, outgoing mail is working.",
          idempotencyKey: `smtp-mailer-test:${crypto.randomUUID()}`,
        });
        return { accepted: true as const, mode };
      },
      { body: t.Object({ to: t.String({ format: "email", maxLength: 320 }) }) },
    );
}

/** Server type for a typed Eden client on the web (paths include the prefix). */
export type SmtpMailerPluginApp = ReturnType<typeof buildSmtpMailerRoutes>;

/**
 * smtp-mailer plugin — supplies Core's active {@link MailProvider} (dependency
 * inversion, mirroring `StorageProvider`). `send()` enqueues to an outbox and a
 * background worker drains it with exponential backoff + a bounded retry budget;
 * with no `SMTP_HOST` configured it runs log-only so mail flows are testable with
 * zero config. Credentials come from env; non-secret presentation from an admin
 * page. Uses nodemailer (justified: Bun has no native SMTP client — see §6).
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "SMTP Mailer",
  version: "0.1.0",
  description: "Outgoing email via SMTP (nodemailer) with a retrying outbox; log-only without SMTP config.",
  capabilities: ["routes", "tables", "mail-providers", "jobs", "admin-pages"],
  migrations: {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsTable: "__drizzle_migrations_smtp-mailer",
  },
  register(ctx) {
    // Secrets from env only (never admin-editable / browser-visible). No host
    // configured → log-only mode: send() logs instead of dialing SMTP.
    const secrets = readSmtpSecrets();
    // Production must have real SMTP: refuse log-only there (it would let a
    // password-reset request "succeed" without ever sending mail). Throwing makes
    // the loader skip this plugin, so Core's MailService stays unconfigured and
    // forgot-password returns an honest 503 instead of a silent 200. Log-only
    // stays available in development/test for zero-config flows.
    if (!secrets && Bun.env.NODE_ENV === "production") {
      throw new Error(
        "smtp-mailer: SMTP_HOST is required in production — refusing to run in log-only mode.",
      );
    }
    const transport = secrets ? createNodemailerTransport(secrets) : null;
    const provider = createMailProvider({ db: ctx.db, log: ctx.log, transport });

    if (transport) {
      // Drain the outbox in the background (only meaningful with a transport;
      // log-only never enqueues). unref'd so it can't hold the process open.
      startWorker({ db: ctx.db, transport, log: ctx.log });
      ctx.log.info("smtp_mailer_ready", { mode: "smtp", host: secrets?.host });
    } else {
      ctx.log.info("smtp_mailer_ready", { mode: "log-only" });
    }

    return {
      routes: buildSmtpMailerRoutes(ctx, { provider, transport }),
      adminPages: [{ id: "smtp-mailer", title: "Email (SMTP)" }],
      mailProvider: provider,
    };
  },
});
