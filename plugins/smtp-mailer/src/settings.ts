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
 * omitted keys keep their stored value (a fresh row uses the schema defaults).
 *
 * The write touches ONLY the supplied columns — both in the insert and in the
 * conflict `set` clause — so it's a single atomic statement with no
 * read-modify-write. Two concurrent partial updates can't clobber each other's
 * fields (an omitted column keeps its live DB value, not a stale read), and
 * `RETURNING` yields the authoritative post-write row.
 */
export async function updateMailSettings(db: DB, update: MailSettingsUpdate): Promise<MailSettings> {
  const patch: Partial<typeof mailSettings.$inferInsert> = { updatedAt: new Date() };
  if (update.fromName !== undefined) patch.fromName = update.fromName;
  if (update.fromAddress !== undefined) patch.fromAddress = update.fromAddress;
  if (update.replyTo !== undefined) patch.replyTo = update.replyTo;
  if (update.enabled !== undefined) patch.enabled = update.enabled;

  const [row] = await db
    .insert(mailSettings)
    .values({ id: SETTINGS_ROW_ID, ...patch })
    .onConflictDoUpdate({ target: mailSettings.id, set: patch })
    .returning();
  if (!row) throw new Error("mail settings upsert returned no row");
  return {
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    enabled: row.enabled,
  };
}
