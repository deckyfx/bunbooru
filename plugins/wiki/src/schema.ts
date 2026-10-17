import { sql } from "drizzle-orm";
import { bigint, bigserial, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One wiki page, typically explaining a tag: its `title` is the tag's
 * normalized name (see `title.ts`). `version` counts edits from 1 and equals
 * the newest {@link wikiPageVersions} row's; every edit bumps it under the
 * row's lock. `updatedByName` is copied from the editor (no cross-schema FK to
 * Core's users).
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    version: integer("version").notNull(),
    updatedByName: text("updated_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One page per title; serves lookups by title.
    uniqueIndex("wiki_pages_title_unique").on(table.title),
    // The alphabetical index and prefix search, byte-wise: under the "C"
    // collation a `LIKE 'abc%'` and a keyset `> last` both range-scan this,
    // whatever the database's default collation.
    index("wiki_pages_title_c_idx").on(sql`${table.title} COLLATE "C"`),
  ],
);

/**
 * Every revision of a page, append-only: an edit or a revert adds a row, so
 * history is never rewritten. Deleting the page deletes its history (FK within
 * the plugin's own tables).
 */
export const wikiPageVersions = pgTable(
  "wiki_page_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    editorName: text("editor_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A page's history, newest first, keyset by version.
  (table) => [uniqueIndex("wiki_page_versions_page_version_unique").on(table.pageId, table.version)],
);

export type WikiPageRow = typeof wikiPages.$inferSelect;
export type WikiPageVersionRow = typeof wikiPageVersions.$inferSelect;
