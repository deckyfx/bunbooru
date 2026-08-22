/**
 * SMTP secrets — read from ENV only (doc §6 config split). These are credentials
 * and connection details: never admin-editable, never returned to a browser.
 * Non-secret presentation settings (from name/address, reply-to) live in the
 * plugin's own table instead (see `schema.ts` / `settings.ts`).
 */

/** Parsed, validated SMTP connection secrets from env. */
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

/** Default SMTP port when `SMTP_PORT` is unset: STARTTLS submission (587). */
const DEFAULT_SMTP_PORT = 587;

/**
 * Read SMTP secrets from env. Returns `null` when `SMTP_HOST` is unset/blank —
 * the signal to run in log-only mode (see {@link isLogOnly}). A present-but-
 * invalid `SMTP_PORT`/`SMTP_SECURE` throws so a misconfiguration fails loudly
 * rather than dialing the wrong port silently.
 */
export function readSmtpSecrets(env: Record<string, string | undefined> = Bun.env): SmtpSecrets | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;

  const rawPort = env.SMTP_PORT?.trim();
  let port = DEFAULT_SMTP_PORT;
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`SMTP_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
    }
  }

  const rawSecure = env.SMTP_SECURE?.trim().toLowerCase();
  let secure: boolean;
  if (rawSecure === undefined || rawSecure === "") {
    // Implicit TLS iff the well-known SMTPS port; otherwise STARTTLS.
    secure = port === 465;
  } else if (rawSecure === "true" || rawSecure === "1") {
    secure = true;
  } else if (rawSecure === "false" || rawSecure === "0") {
    secure = false;
  } else {
    throw new Error(`SMTP_SECURE must be true/false (or 1/0), got "${rawSecure}"`);
  }

  const user = env.SMTP_USER?.trim() || undefined;
  const password = env.SMTP_PASSWORD ?? undefined; // not trimmed: passwords may hold spaces

  return { host, port, user, password, secure };
}

/**
 * Whether the plugin runs in log-only mode — true when no SMTP host is
 * configured. In this mode `send()` logs the message instead of dialing SMTP, so
 * mail-dependent flows are testable with zero configuration (doc §6 Development).
 */
export function isLogOnly(env: Record<string, string | undefined> = Bun.env): boolean {
  return readSmtpSecrets(env) === null;
}
