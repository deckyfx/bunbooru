import { sql } from "drizzle-orm";
import { bigint, bigserial, check, doublePrecision, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One note: a box over a post's image with text (usually a translation).
 * The box is in FRACTIONS of the image (see `NoteBox`), so it survives any
 * display size; the CHECKs keep it on the image (with 1e-9 of float slack on
 * the far edges). `assetId` and `authorId` mirror Core's ids with no
 * cross-schema foreign keys (a deleted post is handled by the `asset.deleted`
 * listener); `authorName` is copied since the plugin can't read Core's users.
 */
export const notes = pgTable(
  "notes_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    assetId: bigint("asset_id", { mode: "number" }).notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    w: doublePrecision("w").notNull(),
    h: doublePrecision("h").notNull(),
    body: text("body").notNull(),
    authorId: bigint("author_id", { mode: "number" }),
    authorName: text("author_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A post's notes, the only way they're read.
    index("notes_notes_asset_idx").on(table.assetId),
    check("notes_notes_x_check", sql`${table.x} >= 0`),
    check("notes_notes_y_check", sql`${table.y} >= 0`),
    check("notes_notes_w_check", sql`${table.w} > 0`),
    check("notes_notes_h_check", sql`${table.h} > 0`),
    check("notes_notes_right_check", sql`${table.x} + ${table.w} <= 1 + 1e-9`),
    check("notes_notes_bottom_check", sql`${table.y} + ${table.h} <= 1 + 1e-9`),
  ],
);

export type NoteRow = typeof notes.$inferSelect;
