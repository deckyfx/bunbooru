/**
 * SMTP connection secrets, derived from the admin-saved settings (the plugin's
 * own table) — NOT from env. The whole configuration is UI-driven; there is no
 * `SMTP_*` env path. The password lives in the settings table and is never
 * returned to a browser (the admin form is write-only).
 */
import type { MailSettings } from "./settings";

/** Parsed SMTP connection secrets. */
export interface SmtpSecrets {
  host: string;
  port: number;
  /** SMTP AUTH username (optional — some relays are IP-allowlisted). */
  user?: string;
  /** SMTP AUTH password (optional; paired with `user`). */
  password?: string;
  /** true → implicit TLS (port 465). false → STARTTLS upgrade (587/25). */
  secure: boolean;
}

/** Default port for STARTTLS submission (secure=false). */
const STARTTLS_SMTP_PORT = 587;
/** Default port for implicit TLS (secure=true). */
const IMPLICIT_TLS_SMTP_PORT = 465;

/**
 * Derive connection secrets from the saved settings, or `null` when no host is
 * configured — the signal to run in log-only mode. An out-of-range/absent port
 * falls back to the mode's conventional default: 465 for implicit TLS, else 587
 * (the admin UI validates on input too).
 */
export function secretsFromSettings(settings: MailSettings): SmtpSecrets | null {
  const host = settings.host?.trim();
  if (!host) return null;

  const port =
    settings.port !== null && Number.isInteger(settings.port) && settings.port >= 1 && settings.port <= 65535
      ? settings.port
      : settings.secure
        ? IMPLICIT_TLS_SMTP_PORT
        : STARTTLS_SMTP_PORT;

  const user = settings.username?.trim() || undefined;
  // Not trimmed: passwords may hold spaces. Empty/unset counts as absent.
  const password = settings.password && settings.password !== "" ? settings.password : undefined;

  return { host, port, user, password, secure: settings.secure };
}
