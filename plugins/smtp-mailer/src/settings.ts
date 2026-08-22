import { eq } from "drizzle-orm";

import type { DB } from "@bunbooru/plugin-sdk";

import { mailSettings, SETTINGS_ROW_ID } from "./schema";

/**
 * The plugin's full settings — presentation (from/reply-to/enabled) AND the SMTP
 * connection (host/port/secure/username/password). All admin-editable via the UI;
 * no env. `password` is included here for the transport's use, but the API layer
 * NEVER returns it to a browser (the admin form is write-only).
 */
export interface MailSettings {
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  enabled: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  password: string | null;
}

/** A partial update (only provided keys change; `undefined` keeps, `null` clears). */
export interface MailSettingsUpdate {
  fromName?: string | null;
  fromAddress?: string | null;
  replyTo?: string | null;
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  secure?: boolean;
  username?: string | null;
  password?: string | null;
}

/** The defaults used before an admin has ever saved settings. */
const DEFAULTS: MailSettings = {
  fromName: null,
  fromAddress: null,
  replyTo: null,
  enabled: true,
  host: null,
  port: null,
  secure: false,
  username: null,
  password: null,
};

/** Project a DB row onto {@link MailSettings}. */
function toSettings(row: typeof mailSettings.$inferSelect): MailSettings {
  return {
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password: row.password,
  };
}

/** Read the singleton settings row, falling back to {@link DEFAULTS} if unset. */
export async function getMailSettings(db: DB): Promise<MailSettings> {
  const rows = await db
    .select()
    .from(mailSettings)
    .where(eq(mailSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  const row = rows[0];
  return row ? toSettings(row) : { ...DEFAULTS };
}

/**
 * Upsert the singleton settings row. Only the keys present in `update` change;
 * omitted keys keep their stored value (a fresh row uses the schema defaults).
 *
 * The write touches ONLY the supplied columns — both in the insert and in the
 * conflict `set` clause — so it's a single atomic statement with no
 * read-modify-write. Two concurrent partial updates can't clobber each other's
 * fields, and `RETURNING` yields the authoritative post-write row.
 */
export async function updateMailSettings(db: DB, update: MailSettingsUpdate): Promise<MailSettings> {
  const patch: Partial<typeof mailSettings.$inferInsert> = { updatedAt: new Date() };
  if (update.fromName !== undefined) patch.fromName = update.fromName;
  if (update.fromAddress !== undefined) patch.fromAddress = update.fromAddress;
  if (update.replyTo !== undefined) patch.replyTo = update.replyTo;
  if (update.enabled !== undefined) patch.enabled = update.enabled;
  if (update.host !== undefined) patch.host = update.host;
  if (update.port !== undefined) patch.port = update.port;
  if (update.secure !== undefined) patch.secure = update.secure;
  if (update.username !== undefined) patch.username = update.username;
  // Password is write-only: a non-empty string SETS it, an explicit `null` CLEARS
  // it, and `""` (or omitted) KEEPS the stored one — so submitting an unchanged
  // blank field never wipes valid credentials.
  if (update.password !== undefined && update.password !== "") patch.password = update.password;

  const [row] = await db
    .insert(mailSettings)
    .values({ id: SETTINGS_ROW_ID, ...patch })
    .onConflictDoUpdate({ target: mailSettings.id, set: patch })
    .returning();
  if (!row) throw new Error("mail settings upsert returned no row");
  return toSettings(row);
}
