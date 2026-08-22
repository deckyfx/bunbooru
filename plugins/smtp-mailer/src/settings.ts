import { eq } from "drizzle-orm";

import type { DB } from "@bunbooru/plugin-sdk";

import { mailSettings, SETTINGS_ROW_ID } from "./schema";

/** Non-secret operational settings, as surfaced to the admin UI. */
export interface MailSettings {
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  enabled: boolean;
}

/** A partial update of the non-secret settings (only provided keys change). */
export interface MailSettingsUpdate {
  fromName?: string | null;
  fromAddress?: string | null;
  replyTo?: string | null;
  enabled?: boolean;
}

/** The defaults used before an admin has ever saved settings. */
const DEFAULTS: MailSettings = {
  fromName: null,
  fromAddress: null,
  replyTo: null,
  enabled: true,
};

/** Read the singleton settings row, falling back to {@link DEFAULTS} if unset. */
export async function getMailSettings(db: DB): Promise<MailSettings> {
  const rows = await db
    .select()
    .from(mailSettings)
    .where(eq(mailSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    enabled: row.enabled,
  };
}

/**
 * Upsert the singleton settings row. Only the keys present in `update` change;
 * omitted keys keep their stored value (a fresh row uses {@link DEFAULTS}).
 */
export async function updateMailSettings(db: DB, update: MailSettingsUpdate): Promise<MailSettings> {
  const current = await getMailSettings(db);
  const next: MailSettings = {
    fromName: update.fromName !== undefined ? update.fromName : current.fromName,
    fromAddress: update.fromAddress !== undefined ? update.fromAddress : current.fromAddress,
    replyTo: update.replyTo !== undefined ? update.replyTo : current.replyTo,
    enabled: update.enabled !== undefined ? update.enabled : current.enabled,
  };
  await db
    .insert(mailSettings)
    .values({ id: SETTINGS_ROW_ID, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: mailSettings.id,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}
