import { treaty } from "@elysiajs/eden";

import type { SmtpMailerPluginApp } from "@bunbooru/plugin-smtp-mailer";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the smtp-mailer plugin's admin routes (`/status`,
 * `/settings`, `/test`). Built from the plugin's own exported
 * {@link SmtpMailerPluginApp} type; paths include the
 * `/api/v1/plugins/smtp-mailer` prefix. SMTP secrets are never exposed by these
 * routes — only mode, probe result, non-secret settings, and outbox counts.
 */
export const smtpMailerApi = treaty<SmtpMailerPluginApp>(treatyOrigin, treatyOptions);
