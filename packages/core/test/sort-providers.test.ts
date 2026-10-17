import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { CORE_ORDER_KEYS } from "../src/search/core-orders";
import {
  createSortProviderRegistry,
  SortProviderConflictError,
  type SortProvider,
} from "../src/search/sort-providers";

const provider = (key: string): SortProvider => ({ key, value: () => sql`0` });

describe("sort provider registry", () => {
  it("registers an owner's providers and finds them by key", () => {
    const registry = createSortProviderRegistry();
    registry.register("scores", [provider("score")]);
    expect(registry.get("score")?.key).toBe("score");
    expect(registry.entries()).toEqual([{ key: "score", ownerId: "scores" }]);
  });

  it("replaces an owner's set on re-register, and unregister removes all of it", () => {
    const registry = createSortProviderRegistry();
    registry.register("scores", [provider("score"), provider("upvotes")]);
    registry.register("scores", [provider("score")]);
    expect(registry.entries().map((e) => e.key)).toEqual(["score"]);
    registry.unregister("scores");
    expect(registry.get("score")).toBeUndefined();
    expect(registry.entries()).toEqual([]);
    registry.unregister("nobody"); // no-op
  });

  it("reserves every Core order key", () => {
    expect([...CORE_ORDER_KEYS].sort()).toEqual(["date", "id", "random", "size", "tagcount", "views"]);
  });

  it.each([
    ["a Core order key", "views"],
    ["another Core order key", "random"],
    ["Core's id", "id"],
    ["a malformed key", "Score"],
    ["a key with a colon", "score:x"],
    ["a key starting with a digit", "1score"],
    ["an empty key", ""],
    ["a key ending in _asc", "score_asc"],
    ["a key ending in _desc", "score_desc"],
  ])("refuses %s", (_label, key) => {
    const registry = createSortProviderRegistry();
    expect(() => registry.register("p", [provider(key)])).toThrow(SortProviderConflictError);
  });

  it("refuses a key another plugin owns, and a key declared twice", () => {
    const registry = createSortProviderRegistry();
    registry.register("scores", [provider("score")]);
    expect(() => registry.register("other", [provider("score")])).toThrow(/already provided by scores/);
    expect(() => registry.register("dup", [provider("x"), provider("x")])).toThrow(/declared twice/);
  });

  it("is all-or-nothing: a refused set changes nothing", () => {
    const registry = createSortProviderRegistry();
    registry.register("scores", [provider("score")]);
    expect(() => registry.register("scores", [provider("upvotes"), provider("date")])).toThrow();
    expect(registry.entries()).toEqual([{ key: "score", ownerId: "scores" }]); // old set intact
    expect(registry.get("upvotes")).toBeUndefined();
  });
});
