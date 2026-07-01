import { describe, expect, it } from "bun:test";

import type { Tag, TagCategory, TagRepository } from "@bunbooru/db";

import { createTagService, normalizeTagName } from "../src/services/tag-service";

/**
 * In-memory {@link TagRepository} that mirrors the real one's invariants:
 * `getOrCreateByNames` is idempotent, and `setAssetTags` adjusts `postCount` by
 * the add/remove delta — so the service's diff + normalization can be tested
 * without a database.
 */
function fakeTagRepo(): { repo: TagRepository; postCount: (name: string) => number } {
  const byName = new Map<string, Tag>();
  const byId = new Map<number, Tag>();
  const links = new Map<number, Set<number>>();
  let nextId = 1;

  const repo: TagRepository = {
    findByName: async (name) => byName.get(name) ?? null,
    getOrCreateByNames: async (names) =>
      [...new Set(names)].map((name) => {
        let tag = byName.get(name);
        if (!tag) {
          tag = { id: nextId++, name, category: "general", postCount: 0, createdAt: new Date(0) };
          byName.set(name, tag);
          byId.set(tag.id, tag);
        }
        return tag;
      }),
    listForAsset: async (assetId) => {
      const ids = links.get(assetId) ?? new Set<number>();
      return [...ids]
        .map((id) => byId.get(id))
        .filter((t): t is Tag => t !== undefined)
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    },
    setAssetTags: async (assetId, tagIds) => {
      const current = links.get(assetId) ?? new Set<number>();
      const desired = new Set(tagIds);
      for (const id of desired) {
        if (!current.has(id)) {
          const t = byId.get(id);
          if (t) t.postCount += 1;
        }
      }
      for (const id of current) {
        if (!desired.has(id)) {
          const t = byId.get(id);
          if (t) t.postCount -= 1;
        }
      }
      links.set(assetId, desired);
    },
    searchByPrefix: async (prefix, limit) =>
      [...byName.values()]
        .filter((t) => t.name.startsWith(prefix))
        .sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name))
        .slice(0, limit),
    setCategory: async (name, category) => {
      const tag = byName.get(name);
      if (!tag) return null;
      tag.category = category;
      return tag;
    },
    relatedTags: async (name, limit) => {
      const target = byName.get(name);
      if (!target) return [];
      const counts = new Map<number, number>();
      for (const ids of links.values()) {
        if (!ids.has(target.id)) continue;
        for (const tid of ids) {
          if (tid !== target.id) counts.set(tid, (counts.get(tid) ?? 0) + 1);
        }
      }
      return [...counts.entries()]
        .map(([id, c]) => ({ tag: byId.get(id), c }))
        .filter((e): e is { tag: Tag; c: number } => e.tag !== undefined)
        .sort((x, y) => y.c - x.c || y.tag.postCount - x.tag.postCount || x.tag.name.localeCompare(y.tag.name))
        .slice(0, limit)
        .map((e) => e.tag);
    },
  };
  return { repo, postCount: (name) => byName.get(name)?.postCount ?? 0 };
}

describe("normalizeTagName", () => {
  it("lowercases, trims, and collapses whitespace to underscores", () => {
    expect(normalizeTagName("  Hatsune   Miku ")).toBe("hatsune_miku");
    expect(normalizeTagName("1GIRL")).toBe("1girl");
    expect(normalizeTagName("already_underscored")).toBe("already_underscored");
  });

  it("returns null for empty or over-long names", () => {
    expect(normalizeTagName("   ")).toBeNull();
    expect(normalizeTagName("")).toBeNull();
    expect(normalizeTagName("a".repeat(101))).toBeNull();
  });
});

describe("createTagService.setAssetTags", () => {
  it("normalizes, de-dupes, creates missing tags, and bumps postCount", async () => {
    const { repo, postCount } = fakeTagRepo();
    const service = createTagService(repo);

    const result = await service.setAssetTags(7, ["1girl", "  1girl ", "Hatsune Miku"]);

    expect(result.map((t) => t.name).sort()).toEqual(["1girl", "hatsune_miku"]);
    expect(postCount("1girl")).toBe(1);
    expect(postCount("hatsune_miku")).toBe(1);
  });

  it("applies the diff on re-set: removed tags lose a post, kept tags don't double-count", async () => {
    const { repo, postCount } = fakeTagRepo();
    const service = createTagService(repo);

    await service.setAssetTags(7, ["1girl", "solo"]);
    const result = await service.setAssetTags(7, ["1girl", "smile"]);

    expect(result.map((t) => t.name).sort()).toEqual(["1girl", "smile"]);
    expect(postCount("1girl")).toBe(1); // kept — not double-counted
    expect(postCount("solo")).toBe(0); // removed
    expect(postCount("smile")).toBe(1); // added
  });

  it("clears all tags when given an empty list", async () => {
    const { repo, postCount } = fakeTagRepo();
    const service = createTagService(repo);

    await service.setAssetTags(7, ["1girl"]);
    const result = await service.setAssetTags(7, []);

    expect(result).toEqual([]);
    expect(postCount("1girl")).toBe(0);
  });
});

describe("createTagService.autocomplete / setCategory", () => {
  it("returns nothing for an empty prefix and clamps the limit", async () => {
    const { repo } = fakeTagRepo();
    const service = createTagService(repo);
    await repo.getOrCreateByNames(["x", "xeno", "xylophone", "yankee"]);

    expect(await service.autocomplete("   ")).toEqual([]);

    // A huge limit is clamped (no throw, bounded) and the prefix is applied.
    const result = await service.autocomplete("x", 10_000);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.every((tag) => tag.name.startsWith("x"))).toBe(true);
  });

  it("normalizes the name before setting a category", async () => {
    const { repo } = fakeTagRepo();
    const service = createTagService(repo);
    await service.setAssetTags(1, ["hatsune_miku"]);

    const updated = await service.setCategory("Hatsune Miku", "character" satisfies TagCategory);
    expect(updated?.category).toBe("character");
    expect(await service.setCategory("does_not_exist", "artist")).toBeNull();
  });
});

describe("createTagService.relatedTags", () => {
  it("returns co-occurring tags (excluding itself), normalizing the name", async () => {
    const { repo } = fakeTagRepo();
    const service = createTagService(repo);
    await service.setAssetTags(1, ["1girl", "solo", "smile"]);
    await service.setAssetTags(2, ["1girl", "solo"]);
    await service.setAssetTags(3, ["1girl", "smile"]);

    const related = await service.relatedTags("1GIRL"); // normalized → 1girl
    const names = related.map((t) => t.name);
    expect(names).not.toContain("1girl"); // never itself
    expect(names.slice(0, 2).sort()).toEqual(["smile", "solo"]); // each shares 2 assets

    expect(await service.relatedTags("   ")).toEqual([]); // empty name
    expect(await service.relatedTags("unknown_tag")).toEqual([]); // no such tag
  });
});
