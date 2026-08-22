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

import { outboxCounts } from "./outbox";
import { createMailProvider } from "./provider";
import { getMailSettings, updateMailSettings, type MailSettings } from "./settings";
import { createTransportResolver, type TransportResolver } from "./transport";
import { startWorker } from "./worker";

/** This plugin's stable id — route-prefix segment + migrations-table suffix. */
const PLUGIN_ID = "smtp-mailer";

/** Assert the caller is an admin/moderator (401 anonymous / 403 otherwise). */
async function requireAdmin(ctx: PluginContext, request: Request): Promise<void> {
  const user = await ctx.auth.currentUser(request);
  if (!user) throw new AuthenticationError();
  if (!canModerate(user)) throw new AuthorizationError();
}

/**
 * Project settings for the wire — the password is WRITE-ONLY, so it's never
 * returned; a boolean `hasPassword` tells the UI whether one is stored.
 */
function publicSettings(s: MailSettings) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: password !== null && password !== "" };
}

/** Deps the routes close over, resolved once in `register`. */
interface RouteDeps {
  provider: MailProvider;
  /** Resolves the live transport from settings (null in log-only mode). */
  resolver: TransportResolver;
}

/**
 * Build the smtp-mailer's admin HTTP routes. Extracted so its return TYPE drives
 * a typed Eden client on the web ({@link SmtpMailerPluginApp}). Prefixed with
 * {@link pluginRoutePrefix} so paths resolve under `/api/v1/plugins/smtp-mailer`.
 *
 * THE PASSWORD IS NEVER RETURNED — only the mode (smtp vs log-only), the
 * connection probe result, non-secret settings (+ `hasPassword`), and outbox counts.
 */
export function buildSmtpMailerRoutes(ctx: PluginContext, deps: RouteDeps) {
  return new Elysia({ prefix: pluginRoutePrefix(PLUGIN_ID) })
    // Connection status + non-secret settings + outbox counts (admin-only).
    .get("/status", async ({ request }) => {
      await requireAdmin(ctx, request);
      const transport = await deps.resolver.get();
      const mode = transport ? ("smtp" as const) : ("log-only" as const);
      let verified = false;
      // Named `probeError` (not `error`) so the web's `unwrap` envelope helper —
      // which strips any `{ error: unknown }` shape — doesn't collapse this body.
      let probeError: string | null = null;
      try {
        // Probe the transport directly (log-only reports verified with no dial).
        if (transport) await transport.verify();
        verified = true;
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }
      const settings = await getMailSettings(ctx.db);
      const outbox = await outboxCounts(ctx.db);
      return { mode, verified, probeError, settings: publicSettings(settings), outbox };
    })
    // Update settings, incl. the SMTP connection (admin-only). Every field is
    // optional: an omitted key is left UNCHANGED, an explicit `null` clears it.
    // The password is write-only — a value sets it, `null` clears it, omitting it
    // keeps the stored one (so the UI never needs to round-trip the secret).
    .put(
      "/settings",
      async ({ request, body }) => {
        await requireAdmin(ctx, request);
        const settings = await updateMailSettings(ctx.db, {
          ...(body.fromName !== undefined ? { fromName: body.fromName } : {}),
          ...(body.fromAddress !== undefined ? { fromAddress: body.fromAddress } : {}),
          ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.host !== undefined ? { host: body.host } : {}),
          ...(body.port !== undefined ? { port: body.port } : {}),
          ...(body.secure !== undefined ? { secure: body.secure } : {}),
          ...(body.username !== undefined ? { username: body.username } : {}),
          ...(body.password !== undefined ? { password: body.password } : {}),
        });
        return publicSettings(settings);
      },
      {
        body: t.Object({
          fromName: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
          fromAddress: t.Optional(t.Union([t.String({ format: "email", maxLength: 320 }), t.Null()])),
          replyTo: t.Optional(t.Union([t.String({ format: "email", maxLength: 320 }), t.Null()])),
          enabled: t.Optional(t.Boolean()),
          host: t.Optional(t.Union([t.String({ maxLength: 255 }), t.Null()])),
          port: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 65535 }), t.Null()])),
          secure: t.Optional(t.Boolean()),
          username: t.Optional(t.Union([t.String({ maxLength: 255 }), t.Null()])),
          password: t.Optional(t.Union([t.String({ maxLength: 1024 }), t.Null()])),
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
        const mode = (await deps.resolver.isConfigured()) ? ("smtp" as const) : ("log-only" as const);
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
 * background worker drains it with exponential backoff + a bounded retry budget.
 *
 * The SMTP connection (host/port/secure/username/password) is configured entirely
 * from the admin UI (the plugin's own table); there is NO `SMTP_*` env. Until a
 * host is saved the plugin runs log-only (send() logs), and Core's reset/verify
 * flows report "not configured" via the provider's `isConfigured()`. The transport
 * rebuilds automatically when the settings change — no restart. Uses nodemailer
 * (justified: Bun has no native SMTP client — see §6).
 */
export const plugin = definePlugin({
  id: PLUGIN_ID,
  name: "SMTP Mailer",
  version: "0.2.0",
  description: "Outgoing email via SMTP (nodemailer), configured in the admin UI; retrying outbox.",
  capabilities: ["routes", "tables", "mail-providers", "jobs", "admin-pages"],
  tables: ["mail_outbox", "mail_settings"],
  migrations: {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsTable: "__drizzle_migrations_smtp-mailer",
  },
  register(ctx) {
    // The transport is resolved from the admin-saved settings (rebuilt on change);
    // no env. With no host configured it's log-only until an admin sets SMTP up.
    const resolver = createTransportResolver(ctx.db);
    const provider = createMailProvider({ db: ctx.db, log: ctx.log, resolver });

    // Always drain the outbox in the background: the worker holds rows while
    // log-only/paused/misconfigured and delivers once a host is saved. unref'd so
    // it can't hold the process open.
    startWorker({ db: ctx.db, resolver, log: ctx.log });
    ctx.log.info("smtp_mailer_ready", {});

    return {
      routes: buildSmtpMailerRoutes(ctx, { provider, resolver }),
      adminPages: [{ id: "smtp-mailer", title: "Email (SMTP)" }],
      mailProvider: provider,
    };
  },
});
