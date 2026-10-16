import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createSearchProviderRegistry,
  SearchProviderConflictError,
  type SearchProvider,
} from "../src/search/providers";

const provider = (key: string): SearchProvider => ({ key, compile: () => sql`true` });

describe("search provider registry", () => {
  it("registers an owner's providers and finds them by key", () => {
    const registry = createSearchProviderRegistry();
    registry.register("favorites", [provider("fav")]);
    expect(registry.get("fav")?.key).toBe("fav");
    expect(registry.entries()).toEqual([{ key: "fav", ownerId: "favorites" }]);
  });

  it("replaces an owner's set on re-register, and unregister removes all of it", () => {
    const registry = createSearchProviderRegistry();
    registry.register("pools", [provider("pool"), provider("poolname")]);
    registry.register("pools", [provider("pool")]);
    expect(registry.entries().map((e) => e.key)).toEqual(["pool"]);
    registry.unregister("pools");
    expect(registry.get("pool")).toBeUndefined();
    registry.unregister("nobody"); // no-op
  });

  it.each([
    ["a Core key", "rating"],
    ["another Core key", "order"],
    ["a malformed key", "Fav"],
    ["a key with a colon", "fav:x"],
    ["an empty key", ""],
  ])("refuses %s", (_label, key) => {
    const registry = createSearchProviderRegistry();
    expect(() => registry.register("p", [provider(key)])).toThrow(SearchProviderConflictError);
  });

  it("refuses a key another plugin owns, and a key declared twice", () => {
    const registry = createSearchProviderRegistry();
    registry.register("favorites", [provider("fav")]);
    expect(() => registry.register("other", [provider("fav")])).toThrow(/already provided by favorites/);
    expect(() => registry.register("dup", [provider("x"), provider("x")])).toThrow(/declared twice/);
  });

  it("is all-or-nothing: a refused set changes nothing", () => {
    const registry = createSearchProviderRegistry();
    registry.register("pools", [provider("pool")]);
    expect(() => registry.register("pools", [provider("poolx"), provider("rating")])).toThrow();
    expect(registry.entries()).toEqual([{ key: "pool", ownerId: "pools" }]); // old set intact
  });
});
