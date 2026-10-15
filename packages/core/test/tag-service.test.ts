import { describe, expect, it } from "bun:test";

import type { Tag, TagCategory, TagRepository, TagVersion } from "@bunbooru/db";

import { ValidationError } from "../src/errors";
import {
  createTagService,
  normalizeTagName,
  requireTagName,
  type TagServiceDeps,
} from "../src/services/tag-service";

/**
 * In-memory {@link TagRepository} that mirrors the real one's invariants:
 * `getOrCreateByNames` is idempotent, and `setAssetTags` adjusts `postCount` by
 * the add/remove delta — so the service's diff + normalization can be tested
 * without a database.
 */
function fakeTagRepo(): {
  repo: TagRepository;
  postCount: (name: string) => number;
  /** Every setAssetTags call's editor, in order. */
  editors: (number | null)[];
} {
  const editors: (number | null)[] = [];
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
    setAssetTags: async (assetId, tagIds, editorId) => {
      editors.push(editorId);
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
    tagsForAssets: async (assetIds) => {
      const tagIds = new Set<number>();
      for (const assetId of assetIds) {
        for (const tid of links.get(assetId) ?? []) tagIds.add(tid);
      }
      return [...tagIds]
        .map((id) => byId.get(id))
        .filter((t): t is Tag => t !== undefined)
        .sort(
          (a, b) =>
            a.category.localeCompare(b.category) ||
            b.postCount - a.postCount ||
            a.name.localeCompare(b.name),
        );
    },
  };
  return { repo, postCount: (name) => byName.get(name)?.postCount ?? 0, editors };
}

/**
 * The service over `repo`, with no aliases, no implications and no history
 * unless a test overrides them. The closure fake looks up implications by tag
 * NAME through `repo` so tests can declare them as names.
 */
function serviceFor(
  repo: TagRepository,
  overrides: {
    aliases?: Record<string, string>;
    implies?: Record<string, string[]>;
    versions?: Partial<TagServiceDeps["versions"]>;
  } = {},
) {
  const aliasMap = new Map(Object.entries(overrides.aliases ?? {}));
  const implies = overrides.implies ?? {};
  return createTagService({
    tags: repo,
    aliases: {
      resolve: async (names) =>
        new Map(names.filter((n) => aliasMap.has(n)).map((n) => [n, aliasMap.get(n)!])),
    },
    implications: {
      // Transitive closure by name, then mapped back to ids (creating as needed).
      closure: async (ids) => {
        const names = new Set<string>();
        const queue: string[] = [];
        for (const id of ids) {
          for (const [name, targets] of Object.entries(implies)) {
            const tag = await repo.findByName(name);
            if (tag?.id === id) queue.push(...targets);
          }
        }
        while (queue.length > 0) {
          const next = queue.shift()!;
          if (names.has(next)) continue;
          names.add(next);
          queue.push(...(implies[next] ?? []));
        }
        const rows = names.size > 0 ? await repo.getOrCreateByNames([...names]) : [];
        return rows.map((t) => t.id).filter((id) => !ids.includes(id));
      },
    },
    versions: {
      listForAsset: async () => [],
      findById: async () => null,
      ...overrides.versions,
    },
  });
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
    const service = serviceFor(repo);

    const result = await service.setAssetTags(7, ["1girl", "  1girl ", "Hatsune Miku"]);

    expect(result.map((t) => t.name).sort()).toEqual(["1girl", "hatsune_miku"]);
    expect(postCount("1girl")).toBe(1);
    expect(postCount("hatsune_miku")).toBe(1);
  });

  it("applies the diff on re-set: removed tags lose a post, kept tags don't double-count", async () => {
    const { repo, postCount } = fakeTagRepo();
    const service = serviceFor(repo);

    await service.setAssetTags(7, ["1girl", "solo"]);
    const result = await service.setAssetTags(7, ["1girl", "smile"]);

    expect(result.map((t) => t.name).sort()).toEqual(["1girl", "smile"]);
    expect(postCount("1girl")).toBe(1); // kept — not double-counted
    expect(postCount("solo")).toBe(0); // removed
    expect(postCount("smile")).toBe(1); // added
  });

  it("clears all tags when given an empty list", async () => {
    const { repo, postCount } = fakeTagRepo();
    const service = serviceFor(repo);

    await service.setAssetTags(7, ["1girl"]);
    const result = await service.setAssetTags(7, []);

    expect(result).toEqual([]);
    expect(postCount("1girl")).toBe(0);
  });
});

describe("createTagService.tagsForAssets", () => {
  it("unions tags across the given assets, de-duped, and drops invalid ids", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo);
    await service.setAssetTags(1, ["1girl", "solo"]);
    await service.setAssetTags(2, ["1girl", "smile"]); // 1girl shared → once

    const tags = await service.tagsForAssets([1, 2, -5, 0, 2]); // invalid + duplicate ids ignored

    expect(tags.map((t) => t.name).sort()).toEqual(["1girl", "smile", "solo"]);
  });

  it("returns empty for no (valid) ids", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo);
    expect(await service.tagsForAssets([])).toEqual([]);
    expect(await service.tagsForAssets([0, -1])).toEqual([]);
  });
});

describe("createTagService.autocomplete / setCategory", () => {
  it("returns nothing for an empty prefix and clamps the limit", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo);
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
    const service = serviceFor(repo);
    await service.setAssetTags(1, ["hatsune_miku"]);

    const updated = await service.setCategory("Hatsune Miku", "character" satisfies TagCategory);
    expect(updated?.category).toBe("character");
    expect(await service.setCategory("does_not_exist", "artist")).toBeNull();
  });
});

describe("createTagService.relatedTags", () => {
  it("returns co-occurring tags (excluding itself), normalizing the name", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo);
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

describe("createTagService: aliases, implications, history", () => {
  it("rewrites aliased names before tagging, so the antecedent never becomes a tag", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo, { aliases: { kitty: "cat" } });

    const result = await service.setAssetTags(1, ["Kitty", "cat", "solo"]);

    expect(result.map((t) => t.name)).toEqual(["cat", "solo"]);
    expect(await repo.findByName("kitty")).toBeNull();
  });

  it("adds everything the tags imply, transitively", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo, { implies: { kitten: ["cat"], cat: ["animal"] } });

    const result = await service.setAssetTags(1, ["kitten"]);

    expect(result.map((t) => t.name)).toEqual(["animal", "cat", "kitten"]);
  });

  it("puts an implied tag removed by hand straight back while its antecedent stays", async () => {
    const { repo } = fakeTagRepo();
    const service = serviceFor(repo, { implies: { cat: ["animal"] } });
    await service.setAssetTags(1, ["cat"]);

    const result = await service.setAssetTags(1, ["cat"]); // "animal" left out

    expect(result.map((t) => t.name)).toEqual(["animal", "cat"]);
  });

  it("passes the editor through, defaulting to null (system)", async () => {
    const { repo, editors } = fakeTagRepo();
    const service = serviceFor(repo);
    await service.setAssetTags(1, ["a"], 42);
    await service.setAssetTags(1, ["b"]);
    expect(editors).toEqual([42, null]);
  });

  it("clamps the history page size and forwards the keyset cursor", async () => {
    const { repo } = fakeTagRepo();
    const calls: [number, number, number | undefined][] = [];
    const service = serviceFor(repo, {
      versions: {
        listForAsset: async (assetId, limit, beforeId) => {
          calls.push([assetId, limit, beforeId]);
          return [];
        },
      },
    });

    await service.history(7);
    await service.history(7, { limit: 10_000, beforeId: 99 });
    await service.history(7, { limit: Number.NaN });

    expect(calls).toEqual([
      [7, 20, undefined],
      [7, 100, 99],
      [7, 20, undefined],
    ]);
  });

  it("reverts by re-applying the version's set as a new edit, through the rules", async () => {
    const { repo, editors } = fakeTagRepo();
    const version: TagVersion = {
      id: 5,
      assetId: 1,
      userId: 3,
      username: "alice",
      tags: ["kitty", "solo"],
      added: ["kitty", "solo"],
      removed: [],
      createdAt: new Date(0),
    };
    const service = serviceFor(repo, {
      aliases: { kitty: "cat" }, // created after that version was recorded
      versions: { findById: async (id) => (id === 5 ? version : null) },
    });
    await service.setAssetTags(1, ["dog"]);

    const result = await service.revert(1, 5, 9);

    expect(result?.map((t) => t.name)).toEqual(["cat", "solo"]);
    expect(editors.at(-1)).toBe(9);
  });

  it("refuses to revert to a missing version or another post's version", async () => {
    const { repo } = fakeTagRepo();
    const other: TagVersion = {
      id: 6,
      assetId: 2,
      userId: null,
      username: null,
      tags: ["x"],
      added: ["x"],
      removed: [],
      createdAt: new Date(0),
    };
    const service = serviceFor(repo, {
      versions: { findById: async (id) => (id === 6 ? other : null) },
    });

    expect(await service.revert(1, 404, null)).toBeNull();
    expect(await service.revert(1, 6, null)).toBeNull();
  });
});

describe("requireTagName", () => {
  it("normalizes a valid name", () => {
    expect(requireTagName("  Hatsune Miku ", "antecedent")).toBe("hatsune_miku");
  });

  it("rejects an empty name, an over-long one, and a wildcard pattern", () => {
    expect(() => requireTagName("  ", "antecedent")).toThrow(ValidationError);
    expect(() => requireTagName("a".repeat(101), "consequent")).toThrow(/consequent/);
    expect(() => requireTagName("cat*", "antecedent")).toThrow(/\*/);
  });
});
