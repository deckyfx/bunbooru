import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DB } from "../client";
import { tagAliases, tagImplications, tags, users, type Tag } from "../schema";
import { bigintArray } from "./sql-arrays";
import { impliedTagIds, lockTagGardening, type Tx } from "./tag-graph";

/** An implication as callers see it: both tags, resolved. */
export interface TagImplication {
  antecedent: Tag;
  consequent: Tag;
  /** Username of the admin who created it; null if that account is gone. */
  creatorName: string | null;
  createdAt: Date;
}

/** Why {@link TagImplicationRepository.create} refused, checked atomically under the gardening lock. */
export type ImplicationRejection =
  /** `cat → cat`. */
  | "self"
  /** This exact pair already exists. */
  | "exists"
  /** The consequent already implies the antecedent, so the new edge closes a loop. */
  | "cycle"
  /** A side is an alias antecedent: implicate the tag it's aliased to instead. */
  | "aliased";

export type CreateImplicationResult =
  | { ok: true; implication: TagImplication; backfilledPosts: number }
  | { ok: false; reason: ImplicationRejection };

export interface TagImplicationRepository {
  /** A page of implications, ordered by antecedent then consequent name. */
  list(limit: number, offset: number): Promise<TagImplication[]>;
  count(): Promise<number>;
  /** Every tag id `tagIds` imply, transitively, excluding the inputs. */
  closure(tagIds: readonly number[]): Promise<number[]>;
  /**
   * Create `antecedent → consequent` (already-normalized names; missing tags are
   * created) and backfill: every post tagged with the antecedent gets the
   * consequent and everything it implies. One transaction under the gardening
   * lock, integrity checks included.
   */
  create(input: {
    antecedentName: string;
    consequentName: string;
    creatorId: number | null;
  }): Promise<CreateImplicationResult>;
  /** Delete an implication. Tags it already added to posts stay. */
  remove(antecedentName: string, consequentName: string): Promise<boolean>;
}

const antecedentTag = alias(tags, "antecedent_tag");
const consequentTag = alias(tags, "consequent_tag");

/** The {@link TagImplication} projection, over the pool or inside a transaction. */
function selectImplications(handle: DB | Tx) {
  return handle
    .select({
      antecedent: antecedentTag,
      consequent: consequentTag,
      creatorName: users.username,
      createdAt: tagImplications.createdAt,
    })
    .from(tagImplications)
    .innerJoin(antecedentTag, eq(antecedentTag.id, tagImplications.antecedentId))
    .innerJoin(consequentTag, eq(consequentTag.id, tagImplications.consequentId))
    .leftJoin(users, eq(users.id, tagImplications.creatorId));
}

/** Resolve-or-create a tag by name inside `tx`. */
async function ensureTag(tx: Tx, name: string): Promise<Tag> {
  await tx.insert(tags).values({ name }).onConflictDoNothing({ target: tags.name });
  const [row] = await tx.select().from(tags).where(eq(tags.name, name));
  if (!row) throw new Error(`Tag "${name}" vanished mid-transaction`);
  return row;
}

/** Build a {@link TagImplicationRepository} over a {@link DB} handle. */
export function createTagImplicationRepository(db: DB): TagImplicationRepository {
  return {
    list(limit, offset) {
      return selectImplications(db)
        .orderBy(asc(antecedentTag.name), asc(consequentTag.name))
        .limit(limit)
        .offset(offset);
    },

    async count() {
      const [row] = await db.select({ n: count() }).from(tagImplications);
      return row?.n ?? 0;
    },

    closure(tagIds) {
      return impliedTagIds(db, tagIds);
    },

    async create({ antecedentName, consequentName, creatorId }) {
      if (antecedentName === consequentName) return { ok: false, reason: "self" };

      return db.transaction(async (tx): Promise<CreateImplicationResult> => {
        await lockTagGardening(tx);

        const [aliased] = await tx
          .select({ name: tagAliases.antecedentName })
          .from(tagAliases)
          .where(inArray(tagAliases.antecedentName, [antecedentName, consequentName]))
          .limit(1);
        if (aliased) return { ok: false, reason: "aliased" };

        // Check against the tags that exist BEFORE creating any: a rejection
        // returns (it doesn't throw), so the transaction commits, and creating
        // tags first would leave empty ones behind on every refused request.
        const found = await tx
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(inArray(tags.name, [antecedentName, consequentName]));
        const foundAntecedent = found.find((t) => t.name === antecedentName);
        const foundConsequent = found.find((t) => t.name === consequentName);

        let reachable: number[] = [];
        if (foundAntecedent && foundConsequent) {
          const [existing] = await tx
            .select({ id: tagImplications.antecedentId })
            .from(tagImplications)
            .where(
              and(
                eq(tagImplications.antecedentId, foundAntecedent.id),
                eq(tagImplications.consequentId, foundConsequent.id),
              ),
            )
            .limit(1);
          if (existing) return { ok: false, reason: "exists" };

          // `consequent` already reaching `antecedent` means the new edge would
          // close a loop, after which every post in it would carry every tag in it.
          reachable = await impliedTagIds(tx, [foundConsequent.id]);
          if (reachable.includes(foundAntecedent.id)) return { ok: false, reason: "cycle" };
        } else if (foundConsequent) {
          // A brand-new antecedent can't be on a cycle, but the backfill still
          // needs everything the consequent implies.
          reachable = await impliedTagIds(tx, [foundConsequent.id]);
        }

        const antecedent = foundAntecedent ?? (await ensureTag(tx, antecedentName));
        const consequent = foundConsequent ?? (await ensureTag(tx, consequentName));

        await tx
          .insert(tagImplications)
          .values({ antecedentId: antecedent.id, consequentId: consequent.id, creatorId });

        // Materialize onto existing posts. Posts with a tag that implies the
        // antecedent already carry the antecedent itself (it was materialized
        // too), so the antecedent's own posts are the complete set.
        const targets = [consequent.id, ...reachable];
        const [inserted] = await tx.execute<{ n: number | string }>(sql`
          WITH inserted AS (
            INSERT INTO asset_tags (asset_id, tag_id)
            SELECT at.asset_id, target.id
              FROM asset_tags at
              CROSS JOIN unnest(${bigintArray(targets)}) AS target(id)
             WHERE at.tag_id = ${antecedent.id}
            ON CONFLICT DO NOTHING
            RETURNING asset_id
          )
          SELECT count(DISTINCT asset_id) AS n FROM inserted
        `);

        const [created] = await selectImplications(tx).where(
          and(
            eq(tagImplications.antecedentId, antecedent.id),
            eq(tagImplications.consequentId, consequent.id),
          ),
        );
        if (!created) throw new Error("Implication row missing right after insert");
        return { ok: true, implication: created, backfilledPosts: Number(inserted?.n ?? 0) };
      });
    },

    async remove(antecedentName, consequentName) {
      const removed = await db.execute<{ antecedent_id: number | string }>(sql`
        DELETE FROM tag_implications ti
         USING tags a, tags c
         WHERE ti.antecedent_id = a.id AND a.name = ${antecedentName}
           AND ti.consequent_id = c.id AND c.name = ${consequentName}
        RETURNING ti.antecedent_id
      `);
      return [...removed].length > 0;
    },
  };
}
