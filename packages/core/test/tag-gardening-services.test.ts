import { describe, expect, it } from "bun:test";

import type {
  CreateAliasResult,
  CreateImplicationResult,
  Tag,
  TagAlias,
  TagAliasRepository,
  TagImplication,
  TagImplicationRepository,
} from "@bunbooru/db";

import { ConflictError, ValidationError } from "../src/errors";
import { createTagAliasService } from "../src/services/tag-alias-service";
import { createTagImplicationService } from "../src/services/tag-implication-service";

const tag = (id: number, name: string): Tag => ({
  id,
  name,
  category: "general",
  postCount: 0,
  createdAt: new Date(0),
});
const alias: TagAlias = {
  antecedentName: "kitty",
  consequent: tag(1, "cat"),
  creatorName: null,
  createdAt: new Date(0),
};
const implication: TagImplication = {
  antecedent: tag(1, "cat"),
  consequent: tag(2, "animal"),
  creatorName: null,
  createdAt: new Date(0),
};

/** An alias repository whose `create` answers `result` and records its input. */
function aliasRepo(result: CreateAliasResult) {
  const calls: unknown[] = [];
  const repo: TagAliasRepository = {
    list: async (limit, offset) => {
      calls.push({ limit, offset });
      return [alias];
    },
    count: async () => 120,
    resolve: async () => new Map(),
    create: async (input) => {
      calls.push(input);
      return result;
    },
    remove: async (name) => {
      calls.push(name);
      return true;
    },
  };
  return { repo, calls };
}

function implicationRepo(result: CreateImplicationResult) {
  const calls: unknown[] = [];
  const repo: TagImplicationRepository = {
    list: async () => [implication],
    count: async () => 1,
    closure: async () => [],
    create: async (input) => {
      calls.push(input);
      return result;
    },
    remove: async (a, c) => {
      calls.push([a, c]);
      return true;
    },
  };
  return { repo, calls };
}

describe("TagAliasService", () => {
  it("normalizes both names and passes the creator through", async () => {
    const { repo, calls } = aliasRepo({ ok: true, alias, migratedPosts: 3 });
    const result = await createTagAliasService(repo).create(" Kitty ", "Cat", 7);
    expect(result).toEqual({ alias, migratedPosts: 3 });
    expect(calls).toEqual([{ antecedentName: "kitty", consequentName: "cat", creatorId: 7 }]);
  });

  it("rejects an invalid name before reaching the repository", async () => {
    const { repo, calls } = aliasRepo({ ok: true, alias, migratedPosts: 0 });
    const service = createTagAliasService(repo);
    await expect(service.create("   ", "cat", null)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.create("kit*", "cat", null)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toEqual([]);
  });

  it("maps a duplicate to ConflictError and every other refusal to ValidationError", async () => {
    await expect(
      createTagAliasService(aliasRepo({ ok: false, reason: "exists" }).repo).create("a", "b", null),
    ).rejects.toBeInstanceOf(ConflictError);
    for (const reason of [
      "self",
      "consequent-is-aliased",
      "antecedent-is-target",
      "antecedent-has-implications",
    ] as const) {
      await expect(
        createTagAliasService(aliasRepo({ ok: false, reason }).repo).create("a", "b", null),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("pages the list and reports the totals", async () => {
    const { repo, calls } = aliasRepo({ ok: true, alias, migratedPosts: 0 });
    const page = await createTagAliasService(repo).list({ page: 3, perPage: 50 });
    expect(calls).toEqual([{ limit: 50, offset: 100 }]);
    expect(page).toMatchObject({ items: [alias], total: 120, page: 3, perPage: 50, pageCount: 3 });
  });

  it("normalizes on remove and returns false for an unusable name", async () => {
    const { repo, calls } = aliasRepo({ ok: true, alias, migratedPosts: 0 });
    const service = createTagAliasService(repo);
    expect(await service.remove(" Kitty ")).toBe(true);
    expect(await service.remove("   ")).toBe(false);
    expect(calls).toEqual(["kitty"]);
  });
});

describe("TagImplicationService", () => {
  it("normalizes both names and returns the backfill count", async () => {
    const { repo, calls } = implicationRepo({ ok: true, implication, backfilledPosts: 4 });
    const result = await createTagImplicationService(repo).create("Cat", " Animal", 7);
    expect(result).toEqual({ implication, backfilledPosts: 4 });
    expect(calls).toEqual([{ antecedentName: "cat", consequentName: "animal", creatorId: 7 }]);
  });

  it("maps a duplicate to ConflictError and other refusals to ValidationError", async () => {
    const make = (reason: "exists" | "self" | "cycle" | "aliased") =>
      createTagImplicationService(implicationRepo({ ok: false, reason }).repo).create("a", "b", null);
    await expect(make("exists")).rejects.toBeInstanceOf(ConflictError);
    await expect(make("self")).rejects.toBeInstanceOf(ValidationError);
    await expect(make("cycle")).rejects.toThrow(/loop/);
    await expect(make("aliased")).rejects.toBeInstanceOf(ValidationError);
  });

  it("normalizes on remove", async () => {
    const { repo, calls } = implicationRepo({ ok: true, implication, backfilledPosts: 0 });
    const service = createTagImplicationService(repo);
    expect(await service.remove("Cat", "ANIMAL")).toBe(true);
    expect(await service.remove("", "animal")).toBe(false);
    expect(calls).toEqual([["cat", "animal"]]);
  });
});
