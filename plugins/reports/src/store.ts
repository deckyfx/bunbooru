import { and, desc, eq, lt } from "drizzle-orm";

import { ConflictError, type DB } from "@bunbooru/plugin-sdk";

import { reports, type ReportRow, type ReportStatus } from "./schema";

/** True for a Postgres unique violation, through Drizzle's / bun-sql's error wrapping. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, errno } = e as { code?: unknown; errno?: unknown };
    if (code === "23505" || errno === "23505") return true;
  }
  return false;
}

/** File a report. 409 when this reporter already has an open report on the post. */
export async function createReport(
  db: DB,
  report: { assetId: number; reporterId: number; reporterName: string; reason: string },
): Promise<ReportRow> {
  try {
    const [row] = await db.insert(reports).values(report).returning();
    if (!row) throw new Error("report insert returned no row");
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("You've already reported this post");
    throw error;
  }
}

/** A report by id, or null. */
export async function findReport(db: DB, id: number): Promise<ReportRow | null> {
  const [row] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
  return row ?? null;
}

/** One status's reports, newest first, keyset-paged by id (the queue index). */
export async function listReports(
  db: DB,
  { status, before, limit }: { status: ReportStatus; before?: number; limit: number },
): Promise<ReportRow[]> {
  return db
    .select()
    .from(reports)
    .where(and(eq(reports.status, status), before !== undefined ? lt(reports.id, before) : undefined))
    .orderBy(desc(reports.id))
    .limit(limit);
}

/** A post's open reports, newest first. */
export async function openReportsForAsset(db: DB, assetId: number): Promise<ReportRow[]> {
  return db
    .select()
    .from(reports)
    .where(and(eq(reports.assetId, assetId), eq(reports.status, "open")))
    .orderBy(desc(reports.id));
}

/**
 * Close an OPEN report as `status`. Null when it isn't open (or doesn't
 * exist): the status guard is in the UPDATE itself, so two moderators racing
 * on one report can't both close it.
 */
export async function closeReport(
  db: DB,
  id: number,
  close: { status: Exclude<ReportStatus, "open">; resolution: string | null; resolvedByName: string | null },
): Promise<ReportRow | null> {
  const [row] = await db
    .update(reports)
    .set({ ...close, resolvedAt: new Date() })
    .where(and(eq(reports.id, id), eq(reports.status, "open")))
    .returning();
  return row ?? null;
}

/** Resolve every open report on a post in one statement; returns how many. */
export async function resolveOpenForAsset(db: DB, assetId: number, resolution: string): Promise<number> {
  const resolved = await db
    .update(reports)
    .set({ status: "resolved", resolution, resolvedByName: null, resolvedAt: new Date() })
    .where(and(eq(reports.assetId, assetId), eq(reports.status, "open")))
    .returning({ id: reports.id });
  return resolved.length;
}
