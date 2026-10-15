import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createAssetRepository,
  createDb,
  createTagAliasRepository,
  createTagImplicationRepository,
  createTagRepository,
  createTagVersionRepository,
  createUserRepository,
  type AssetRepository,
  type DB,
  type TagAliasRepository,
  type TagImplicationRepository,
  type TagRepository,
  type TagVersionRepository,
} from "../src/index";

/**
 * Integration tests for aliases, implications and tag history, against a real
 * Postgres (opt-in via TEST_DATABASE_URL; see asset-repository.test). These lock
 * down the parts only SQL can prove: the migrations move links and keep
 * `postCount` right, the integrity checks hold, and rejections leave no trace.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

/** SHA-256-shaped hex digest unique per key (passes the assets hex CHECK). */
function digest(key: string, len: number): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, len);
}

describe.skipIf(!TEST_DATABASE_URL)("tag gardening repositories (integration)", () => {
  let db: DB;
  let tags: TagRepository;
  let aliases: TagAliasRepository;
  let implications: TagImplicationRepository;
  let versions: TagVersionRepository;
  let assets: AssetRepository;
  let adminId: number;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    tags = createTagRepository(db);
    aliases = createTagAliasRepository(db);
    implications = createTagImplicationRepository(db);
    versions = createTagVersionRepository(db);
    assets = createAssetRepository(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE assets, tags, asset_tags, tag_aliases, tag_implications, asset_tag_versions, users RESTART IDENTITY CASCADE`,
    );
    const admin = await createUserRepository(db).create({
      username: "admin",
      email: null,
      passwordHash: "hash:admin",
      role: "admin",
    });
    adminId = admin.id;
  });

  async function seedAsset(key: string): Promise<number> {
    const asset = await assets.create({
      storageKey: `assets/${key}`,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sizeBytes: 1,
      sha256: digest(`sha:${key}`, 64),
      md5: digest(`md5:${key}`, 32),
    });
    return asset.id;
  }

  /** Tag an asset by names (creating tags) the way the service does, minus rules. */
  async function tagAsset(assetId: number, names: string[], editorId: number | null = null) {
    const rows = await tags.getOrCreateByNames(names);
    await tags.setAssetTags(
      assetId,
      rows.map((t) => t.id),
      editorId,
    );
  }

  const namesOn = async (assetId: number) => (await tags.listForAsset(assetId)).map((t) => t.name);
  const countOf = async (name: string) => (await tags.findByName(name))?.postCount;

  describe("aliases", () => {
    it("migrates every post from the antecedent and deletes the antecedent tag", async () => {
      const a1 = await seedAsset("a1");
      const a2 = await seedAsset("a2");
      await tagAsset(a1, ["kitty", "solo"]);
      await tagAsset(a2, ["kitty", "cat"]); // already has the consequent too

      const result = await aliases.create({
        antecedentName: "kitty",
        consequentName: "cat",
        creatorId: adminId,
      });

      expect(result).toMatchObject({ ok: true, migratedPosts: 2 });
      if (!result.ok) throw new Error("unreachable");
      expect(result.alias).toMatchObject({ antecedentName: "kitty", creatorName: "admin" });
      expect(result.alias.consequent.name).toBe("cat");
      expect(await namesOn(a1)).toEqual(["cat", "solo"]);
      expect(await namesOn(a2)).toEqual(["cat"]);
      expect(await tags.findByName("kitty")).toBeNull();
      expect(await countOf("cat")).toBe(2);
    });

    it("also gives migrated posts everything the consequent implies", async () => {
      const a = await seedAsset("a");
      await tagAsset(a, ["kitty"]);
      await implications.create({ antecedentName: "cat", consequentName: "animal", creatorId: null });

      await aliases.create({ antecedentName: "kitty", consequentName: "cat", creatorId: null });

      expect(await namesOn(a)).toEqual(["animal", "cat"]);
    });

    it("works for an antecedent that was never used, creating the consequent", async () => {
      const result = await aliases.create({
        antecedentName: "doggo",
        consequentName: "dog",
        creatorId: null,
      });
      expect(result).toMatchObject({ ok: true, migratedPosts: 0 });
      expect(await tags.findByName("dog")).not.toBeNull();
    });

    it("resolves only the names that are aliased", async () => {
      await aliases.create({ antecedentName: "kitty", consequentName: "cat", creatorId: null });
      const resolved = await aliases.resolve(["kitty", "cat", "solo"]);
      expect([...resolved]).toEqual([["kitty", "cat"]]);
      expect((await aliases.resolve([])).size).toBe(0);
    });

    it.each([
      ["self", "kitty", "kitty"],
      ["exists", "kitty", "feline"],
      ["consequent-is-aliased", "moggy", "kitty"],
      ["antecedent-is-target", "cat", "feline"],
    ] as const)("rejects %s", async (reason, antecedentName, consequentName) => {
      await aliases.create({ antecedentName: "kitty", consequentName: "cat", creatorId: null });
      const result = await aliases.create({ antecedentName, consequentName, creatorId: null });
      expect(result).toEqual({ ok: false, reason });
    });

    it("rejects an antecedent that takes part in implications", async () => {
      await implications.create({ antecedentName: "kitty", consequentName: "animal", creatorId: null });
      const result = await aliases.create({
        antecedentName: "kitty",
        consequentName: "cat",
        creatorId: null,
      });
      expect(result).toEqual({ ok: false, reason: "antecedent-has-implications" });
      expect(await tags.findByName("cat")).toBeNull(); // nothing created on refusal
    });

    it("lists, counts and removes; removing leaves migrated posts on the consequent", async () => {
      const a = await seedAsset("a");
      await tagAsset(a, ["kitty"]);
      await aliases.create({ antecedentName: "kitty", consequentName: "cat", creatorId: adminId });
      await aliases.create({ antecedentName: "doggo", consequentName: "dog", creatorId: null });

      expect((await aliases.list(10, 0)).map((x) => x.antecedentName)).toEqual(["doggo", "kitty"]);
      expect(await aliases.count()).toBe(2);

      expect(await aliases.remove("kitty")).toBe(true);
      expect(await aliases.remove("kitty")).toBe(false);
      expect(await namesOn(a)).toEqual(["cat"]);
      expect(await aliases.count()).toBe(1);
    });
  });

  describe("implications", () => {
    it("backfills existing posts with the consequent and its whole closure", async () => {
      const a1 = await seedAsset("a1");
      const a2 = await seedAsset("a2");
      await tagAsset(a1, ["cat"]);
      await tagAsset(a2, ["cat", "animal"]); // already has the direct consequent
      await implications.create({ antecedentName: "animal", consequentName: "creature", creatorId: null });

      const result = await implications.create({
        antecedentName: "cat",
        consequentName: "animal",
        creatorId: adminId,
      });

      // Only a1 changes: creating `animal → creature` above already backfilled
      // a2 (it carried `animal`), so a2 has nothing left to gain.
      expect(result).toMatchObject({ ok: true, backfilledPosts: 1 });
      expect(await namesOn(a1)).toEqual(["animal", "cat", "creature"]);
      expect(await namesOn(a2)).toEqual(["animal", "cat", "creature"]);
      expect(await countOf("creature")).toBe(2);
    });

    it("computes the transitive closure, excluding the inputs", async () => {
      await implications.create({ antecedentName: "kitten", consequentName: "cat", creatorId: null });
      await implications.create({ antecedentName: "cat", consequentName: "animal", creatorId: null });
      const [kitten, cat, animal] = await Promise.all(
        ["kitten", "cat", "animal"].map((name) => tags.findByName(name)),
      );
      const ids = await implications.closure([kitten!.id]);
      expect(ids.sort((x, y) => x - y)).toEqual([cat!.id, animal!.id].sort((x, y) => x - y));
      expect(await implications.closure([cat!.id, animal!.id])).toEqual([]); // inputs excluded
      expect(await implications.closure([])).toEqual([]);
    });

    it("rejects a loop, a duplicate and a self-implication", async () => {
      await implications.create({ antecedentName: "a", consequentName: "b", creatorId: null });
      await implications.create({ antecedentName: "b", consequentName: "c", creatorId: null });

      expect(
        await implications.create({ antecedentName: "c", consequentName: "a", creatorId: null }),
      ).toEqual({ ok: false, reason: "cycle" });
      expect(
        await implications.create({ antecedentName: "a", consequentName: "b", creatorId: null }),
      ).toEqual({ ok: false, reason: "exists" });
      expect(
        await implications.create({ antecedentName: "a", consequentName: "a", creatorId: null }),
      ).toEqual({ ok: false, reason: "self" });
    });

    it("rejects an aliased name without creating any tag", async () => {
      await aliases.create({ antecedentName: "kitty", consequentName: "cat", creatorId: null });
      const result = await implications.create({
        antecedentName: "kitty",
        consequentName: "pet",
        creatorId: null,
      });
      expect(result).toEqual({ ok: false, reason: "aliased" });
      expect(await tags.findByName("pet")).toBeNull();
    });

    it("lists with both tags resolved, and removing keeps already-added tags", async () => {
      const a = await seedAsset("a");
      await tagAsset(a, ["cat"]);
      await implications.create({ antecedentName: "cat", consequentName: "animal", creatorId: adminId });

      const [listed] = await implications.list(10, 0);
      expect(listed?.antecedent.name).toBe("cat");
      expect(listed?.consequent.name).toBe("animal");
      expect(listed?.creatorName).toBe("admin");
      expect(await implications.count()).toBe(1);

      expect(await implications.remove("cat", "animal")).toBe(true);
      expect(await implications.remove("cat", "animal")).toBe(false);
      expect(await namesOn(a)).toEqual(["animal", "cat"]);
    });
  });

  describe("tag history", () => {
    it("records a version per real change, with the full set and the diff", async () => {
      const a = await seedAsset("a");
      await tagAsset(a, ["solo", "cat"], adminId);
      await tagAsset(a, ["solo", "cat"], adminId); // no change → no version
      await tagAsset(a, ["solo", "dog"], null);

      const history = await versions.listForAsset(a, 10);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        tags: ["dog", "solo"],
        added: ["dog"],
        removed: ["cat"],
        userId: null,
        username: null,
      });
      expect(history[1]).toMatchObject({
        tags: ["cat", "solo"],
        added: ["cat", "solo"],
        removed: [],
        username: "admin",
      });
    });

    it("pages by keyset, newest first", async () => {
      const a = await seedAsset("a");
      for (const name of ["t1", "t2", "t3"]) await tagAsset(a, [name]);

      const first = await versions.listForAsset(a, 2);
      expect(first.map((v) => v.tags)).toEqual([["t3"], ["t2"]]);
      const next = await versions.listForAsset(a, 2, first.at(-1)!.id);
      expect(next.map((v) => v.tags)).toEqual([["t1"]]);
    });

    it("finds a version by id, and null for an unknown id", async () => {
      const a = await seedAsset("a");
      await tagAsset(a, ["solo"]);
      const [latest] = await versions.listForAsset(a, 1);
      expect(await versions.findById(latest!.id)).toMatchObject({ assetId: a, tags: ["solo"] });
      expect(await versions.findById(999_999)).toBeNull();
    });
  });
});
