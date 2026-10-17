import { and, desc, eq, lt, sql } from "drizzle-orm";

import type { DB } from "@bunbooru/plugin-sdk";

import { wikiPages, wikiPageVersions, type WikiPageRow, type WikiPageVersionRow } from "./schema";

/** A page as the index lists it: no body. */
export interface WikiPageSummary {
  title: string;
  version: number;
  updatedByName: string | null;
  updatedAt: Date;
}

/** A revision as the history lists it: no body, just its size. */
export interface WikiVersionSummary {
  version: number;
  editorName: string | null;
  length: number;
  createdAt: Date;
}

/**
 * What saving a page did:
 * - `saved`: a new version was written (or the page created at version 1);
 * - `unchanged`: the body was already that, so nothing was written;
 * - `stale`: `baseVersion` isn't the current version (someone else edited,
 *   created or deleted the page since), so nothing was written.
 */
export type SaveResult =
  | { status: "saved"; page: WikiPageRow }
  | { status: "unchanged"; page: WikiPageRow }
  | { status: "stale" };

/** The title column compared byte-wise, as the `wiki_pages_title_c_idx` index orders it. */
const titleC = sql`${wikiPages.title} COLLATE "C"`;

/** Escape LIKE metacharacters so a user prefix is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** True for a Postgres unique violation, through Drizzle's / bun-sql's error wrapping. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, errno } = e as { code?: unknown; errno?: unknown };
    if (code === "23505" || errno === "23505") return true;
  }
  return false;
}

/** A page by its (normalized) title, or null. */
export async function findPage(db: DB, title: string): Promise<WikiPageRow | null> {
  const [row] = await db.select().from(wikiPages).where(eq(wikiPages.title, title)).limit(1);
  return row ?? null;
}

/**
 * Pages in alphabetical (byte-wise) order, optionally only titles starting
 * with `prefix`, keyset-paged by title (`after` = the last title seen).
 */
export async function listPages(
  db: DB,
  { prefix, after, limit }: { prefix?: string; after?: string; limit: number },
): Promise<WikiPageSummary[]> {
  return db
    .select({
      title: wikiPages.title,
      version: wikiPages.version,
      updatedByName: wikiPages.updatedByName,
      updatedAt: wikiPages.updatedAt,
    })
    .from(wikiPages)
    .where(
      and(
        prefix ? sql`${titleC} LIKE ${`${escapeLike(prefix)}%`}` : undefined,
        after !== undefined ? sql`${titleC} > ${after}` : undefined,
      ),
    )
    .orderBy(titleC)
    .limit(limit);
}

/**
 * Write `body` as the next version of page `title`, creating the page at
 * version 1 when it doesn't exist. The page row is locked for the transaction,
 * so concurrent edits to one page serialize and versions stay 1..n. With a
 * `baseVersion` (0 for "this page didn't exist"), refuses to write over any
 * other current version: that's the optimistic-concurrency check.
 */
export async function savePage(
  db: DB,
  edit: { title: string; body: string; editorName: string; baseVersion?: number },
): Promise<SaveResult> {
  const { title, body, editorName, baseVersion } = edit;
  try {
    return await db.transaction(async (tx): Promise<SaveResult> => {
      const [current] = await tx.select().from(wikiPages).where(eq(wikiPages.title, title)).for("update");
      if (baseVersion !== undefined && baseVersion !== (current?.version ?? 0)) return { status: "stale" };
      if (current && current.body === body) return { status: "unchanged", page: current };

      const [page] = current
        ? await tx
            .update(wikiPages)
            .set({ body, version: current.version + 1, updatedByName: editorName, updatedAt: sql`now()` })
            .where(eq(wikiPages.id, current.id))
            .returning()
        : await tx.insert(wikiPages).values({ title, body, version: 1, updatedByName: editorName }).returning();
      if (!page) throw new Error("wiki page write returned no row");
      await tx
        .insert(wikiPageVersions)
        .values({ pageId: page.id, version: page.version, title, body, editorName });
      return { status: "saved", page };
    });
  } catch (error) {
    // Two first edits raced and the other created the page: this one is stale.
    if (isUniqueViolation(error)) return { status: "stale" };
    throw error;
  }
}

/** A page's versions, newest first, keyset-paged by version (`before` = the last version seen). */
export async function listVersions(
  db: DB,
  { pageId, before, limit }: { pageId: number; before?: number; limit: number },
): Promise<WikiVersionSummary[]> {
  return db
    .select({
      version: wikiPageVersions.version,
      editorName: wikiPageVersions.editorName,
      length: sql<number>`char_length(${wikiPageVersions.body})`.mapWith(Number),
      createdAt: wikiPageVersions.createdAt,
    })
    .from(wikiPageVersions)
    .where(
      and(
        eq(wikiPageVersions.pageId, pageId),
        before !== undefined ? lt(wikiPageVersions.version, before) : undefined,
      ),
    )
    .orderBy(desc(wikiPageVersions.version))
    .limit(limit);
}

/** One version of a page, or null. */
export async function findVersion(db: DB, pageId: number, version: number): Promise<WikiPageVersionRow | null> {
  const [row] = await db
    .select()
    .from(wikiPageVersions)
    .where(and(eq(wikiPageVersions.pageId, pageId), eq(wikiPageVersions.version, version)))
    .limit(1);
  return row ?? null;
}

/** Delete a page and (by cascade) its history; whether it existed. */
export async function deletePage(db: DB, title: string): Promise<boolean> {
  const deleted = await db.delete(wikiPages).where(eq(wikiPages.title, title)).returning({ id: wikiPages.id });
  return deleted.length > 0;
}
