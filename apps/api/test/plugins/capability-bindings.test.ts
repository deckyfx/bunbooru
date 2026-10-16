import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createSearchProviderRegistry, type PluginStateService } from "@bunbooru/core";

import { searchBinding } from "../../src/plugins/capability-bindings";
import { createPluginHost } from "../../src/plugins/host";
import type { LoadedPlugin } from "../../src/plugins/loader";

/** In-memory plugin state, every listed plugin starting inactive. */
function state(): PluginStateService {
  const rows = new Map<string, boolean>();
  return {
    activeIds: async () => new Set([...rows].filter(([, on]) => on).map(([id]) => id)),
    setActive: async (id, active) => {
      rows.set(id, active);
    },
    seedIfEmpty: async () => false,
  };
}

const plugin = (id: string, keys: string[]): LoadedPlugin => ({
  id,
  name: id,
  version: "1.0.0",
  description: null,
  capabilities: ["search-providers"],
  tables: [],
  searchProviders: keys.map((key) => ({ key, compile: () => sql`true` })),
});

describe("search capability binding", () => {
  it("registers a plugin's metatags on activate and removes them on deactivate", async () => {
    const providers = createSearchProviderRegistry();
    const host = createPluginHost({
      pluginState: state(),
      loaded: [plugin("favorites", ["fav"])],
      seedActiveIds: [],
      capabilityBindings: [searchBinding(providers)],
    });
    await host.init();
    expect(providers.get("fav")).toBeUndefined();

    await host.activate("favorites");
    expect(providers.get("fav")).toBeDefined();

    await host.deactivate("favorites");
    expect(providers.get("fav")).toBeUndefined();
  });

  it("fails activation of a plugin whose key collides, leaving it inactive", async () => {
    const providers = createSearchProviderRegistry();
    const host = createPluginHost({
      pluginState: state(),
      loaded: [plugin("favorites", ["fav"]), plugin("copycat", ["fav"])],
      seedActiveIds: [],
      capabilityBindings: [searchBinding(providers)],
    });
    await host.init();
    await host.activate("favorites");

    await expect(host.activate("copycat")).rejects.toThrow(/already provided by favorites/);
    expect(host.isActive("copycat")).toBe(false);
    expect(providers.entries()).toEqual([{ key: "fav", ownerId: "favorites" }]);
  });
});
