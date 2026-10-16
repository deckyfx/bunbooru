import { asc, count, eq, inArray, or, sql } from "drizzle-orm";

import type { DB } from "../client";
import { tagAliases, tagImplications, tags, users, type Tag } from "../schema";
import { bigintArray } from "./sql-arrays";
import { impliedTagIds, lockTagGardening, type Tx } from "./tag-graph";

/** An alias as callers see it: the antecedent NAME and the consequent tag. */
export interface TagAlias {
  antecedentName: string;
  consequent: Tag;
  /** Username of the admin who created it; null if that account is gone. */
  creatorName: string | null;
  createdAt: Date;
}

/** Why {@link TagAliasRepository.create} refused, checked atomically under the gardening lock. */
export type AliasRejection =
  /** `kitty → kitty`. */
  | "self"
  /** The antecedent is already aliased (to anything). */
  | "exists"
  /** The consequent is itself an alias antecedent: `a → b` while `b → c` exists. */
  | "consequent-is-aliased"
  /** Something is already aliased TO the antecedent: `x → a` exists, then `a → b`. */
  | "antecedent-is-target"
  /** The antecedent tag takes part in implications; remove those first. */
  | "antecedent-has-implications";

export type CreateAliasResult =
  | { ok: true; alias: TagAlias; migratedPosts: number }
  | { ok: false; reason: AliasRejection };

export interface TagAliasRepository {
  /** A page of aliases, ordered by antecedent name. */
  list(limit: number, offset: number): Promise<TagAlias[]>;
  count(): Promise<number>;
  /**
   * Antecedent → consequent NAME for those of `names` that are aliased; names
   * without an alias are absent. One query, for tagging and search alike.
   */
  resolve(names: readonly string[]): Promise<Map<string, string>>;
  /**
   * Create `antecedent → consequent` (both already-normalized names) and migrate:
   * every post tagged with the antecedent gets the consequent (plus everything
   * the consequent implies), then the antecedent tag is deleted. All of it, and
   * the integrity checks, in one transaction under the gardening lock.
   */
  create(input: {
    antecedentName: string;
    consequentName: string;
    creatorId: number | null;
  }): Promise<CreateAliasResult>;
  /** Delete an alias. Posts already migrated keep the consequent. */
  remove(antecedentName: string): Promise<boolean>;
}

/** The {@link TagAlias} projection, over the pool or inside a transaction. */
function selectAliases(handle: DB | Tx) {
  return handle
    .select({
      antecedentName: tagAliases.antecedentName,
      consequent: tags,
      creatorName: users.username,
      createdAt: tagAliases.createdAt,
    })
    .from(tagAliases)
    .innerJoin(tags, eq(tags.id, tagAliases.consequentId))
    .leftJoin(users, eq(users.id, tagAliases.creatorId));
}

/** Build a {@link TagAliasRepository} over a {@link DB} handle. */
export function createTagAliasRepository(db: DB): TagAliasRepository {
  return {
    list(limit, offset) {
      return selectAliases(db).orderBy(asc(tagAliases.antecedentName)).limit(limit).offset(offset);
    },

    async count() {
      const [row] = await db.select({ n: count() }).from(tagAliases);
      return row?.n ?? 0;
    },

    async resolve(names) {
      if (names.length === 0) return new Map();
      const rows = await db
        .select({ from: tagAliases.antecedentName, to: tags.name })
        .from(tagAliases)
        .innerJoin(tags, eq(tags.id, tagAliases.consequentId))
        .where(inArray(tagAliases.antecedentName, [...new Set(names)]));
      return new Map(rows.map((row) => [row.from, row.to]));
    },

    async create({ antecedentName, consequentName, creatorId }) {
      if (antecedentName === consequentName) return { ok: false, reason: "self" };

      return db.transaction(async (tx): Promise<CreateAliasResult> => {
        await lockTagGardening(tx);

        const [existing] = await tx
          .select({ name: tagAliases.antecedentName })
          .from(tagAliases)
          .where(eq(tagAliases.antecedentName, antecedentName))
          .limit(1);
        if (existing) return { ok: false, reason: "exists" };

        const [chained] = await tx
          .select({ name: tagAliases.antecedentName })
          .from(tagAliases)
          .where(eq(tagAliases.antecedentName, consequentName))
          .limit(1);
        if (chained) return { ok: false, reason: "consequent-is-aliased" };

        const [antecedent] = await tx.select().from(tags).where(eq(tags.name, antecedentName));
        if (antecedent) {
          const [target] = await tx
            .select({ name: tagAliases.antecedentName })
            .from(tagAliases)
            .where(eq(tagAliases.consequentId, antecedent.id))
            .limit(1);
          if (target) return { ok: false, reason: "antecedent-is-target" };

          const [implication] = await tx
            .select({ id: tagImplications.antecedentId })
            .from(tagImplications)
            .where(
              or(
                eq(tagImplications.antecedentId, antecedent.id),
                eq(tagImplications.consequentId, antecedent.id),
              ),
            )
            .limit(1);
          if (implication) return { ok: false, reason: "antecedent-has-implications" };
        }

        await tx.insert(tags).values({ name: consequentName }).onConflictDoNothing({ target: tags.name });
        const [consequent] = await tx.select().from(tags).where(eq(tags.name, consequentName));
        if (!consequent) throw new Error(`Consequent tag "${consequentName}" vanished mid-transaction`);

        let migratedPosts = 0;
        if (antecedent) {
          // Give every post carrying the antecedent the consequent AND what the
          // consequent implies, since implied tags are materialized on posts.
          const targets = [consequent.id, ...(await impliedTagIds(tx, [consequent.id]))];
          await tx.execute(sql`
            INSERT INTO asset_tags (asset_id, tag_id)
            SELECT at.asset_id, target.id
              FROM asset_tags at
              CROSS JOIN unnest(${bigintArray(targets)}) AS target(id)
             WHERE at.tag_id = ${antecedent.id}
            ON CONFLICT DO NOTHING
          `);
          // Unlink explicitly BEFORE deleting the tag, so the post_count trigger
          // fires per unlinked row rather than leaning on the FK cascade. Counted
          // in SQL: RETURNING every id would ship one row per post to the app.
          const [unlinked] = await tx.execute<{ n: number | string }>(sql`
            WITH unlinked AS (
              DELETE FROM asset_tags WHERE tag_id = ${antecedent.id} RETURNING 1
            )
            SELECT count(*) AS n FROM unlinked
          `);
          migratedPosts = Number(unlinked?.n ?? 0);
          await tx.delete(tags).where(eq(tags.id, antecedent.id));
        }

        await tx.insert(tagAliases).values({ antecedentName, consequentId: consequent.id, creatorId });
        const [created] = await selectAliases(tx).where(eq(tagAliases.antecedentName, antecedentName));
        if (!created) throw new Error("Alias row missing right after insert");
        return { ok: true, alias: created, migratedPosts };
      });
    },

    async remove(antecedentName) {
      const removed = await db
        .delete(tagAliases)
        .where(eq(tagAliases.antecedentName, antecedentName))
        .returning({ name: tagAliases.antecedentName });
      return removed.length > 0;
    },
  };
}
