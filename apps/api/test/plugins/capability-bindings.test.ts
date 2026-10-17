import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createIngestGuardRegistry,
  createJobService,
  createSearchProviderRegistry,
  createSortProviderRegistry,
  type JobHandler,
  type PluginStateService,
} from "@bunbooru/core";
import type { JobRepository } from "@bunbooru/db";

import {
  ingestGuardsBinding,
  jobsBinding,
  searchBinding,
  sortBinding,
} from "../../src/plugins/capability-bindings";
import { createPluginHost } from "../../src/plugins/host";
import type { LoadedPlugin } from "../../src/plugins/loader";

/** In-memory plugin state, every listed plugin starting inactive. Pass `rows` to share it between hosts. */
function state(rows = new Map<string, boolean>()): PluginStateService {
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
  sortProviders: [],
  jobs: {},
  ingestGuards: [],
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

/** A plugin providing sort keys (and nothing else). */
const sortPlugin = (id: string, keys: string[]): LoadedPlugin => ({
  ...plugin(id, []),
  capabilities: ["sort-providers"],
  sortProviders: keys.map((key) => ({ key, value: () => sql`0` })),
});

describe("sort capability binding", () => {
  it("registers a plugin's sort keys on activate and removes them on deactivate", async () => {
    const providers = createSortProviderRegistry();
    const host = createPluginHost({
      pluginState: state(),
      loaded: [sortPlugin("scores", ["score"])],
      seedActiveIds: [],
      capabilityBindings: [sortBinding(providers)],
    });
    await host.init();
    expect(providers.get("score")).toBeUndefined();

    await host.activate("scores");
    expect(providers.get("score")).toBeDefined();

    await host.deactivate("scores");
    expect(providers.get("score")).toBeUndefined();
  });

  it("fails activation of a plugin whose key collides, leaving it inactive", async () => {
    const providers = createSortProviderRegistry();
    const host = createPluginHost({
      pluginState: state(),
      loaded: [sortPlugin("scores", ["score"]), sortPlugin("copycat", ["score"]), sortPlugin("greedy", ["views"])],
      seedActiveIds: [],
      capabilityBindings: [sortBinding(providers)],
    });
    await host.init();
    await host.activate("scores");

    await expect(host.activate("copycat")).rejects.toThrow(/already provided by scores/);
    expect(host.isActive("copycat")).toBe(false);
    // A Core order key is refused the same way.
    await expect(host.activate("greedy")).rejects.toThrow(/reserved by Core/);
    expect(host.isActive("greedy")).toBe(false);
    expect(providers.entries()).toEqual([{ key: "score", ownerId: "scores" }]);
  });
});

/** A plugin providing job handlers, keyed by full kind (as the loader maps them). */
const jobPlugin = (id: string, kinds: string[]): LoadedPlugin => ({
  ...plugin(id, []),
  capabilities: [],
  jobs: Object.fromEntries(kinds.map((kind): [string, JobHandler] => [kind, { run: async () => {} }])),
});

// Registration never touches the repository, so an empty stand-in suffices.
const jobService = () => createJobService({} as JobRepository);

describe("jobs capability binding", () => {
  it("registers a plugin's handlers on activate and removes them on deactivate", async () => {
    const jobs = jobService();
    const host = createPluginHost({
      pluginState: state(),
      loaded: [jobPlugin("thumbnailer", ["thumbnailer:thumbnail"])],
      seedActiveIds: [],
      capabilityBindings: [jobsBinding(jobs)],
    });
    await host.init();
    expect(jobs.kinds()).toEqual([]);

    await host.activate("thumbnailer");
    expect(jobs.handler("thumbnailer:thumbnail")).toBeDefined();

    await host.deactivate("thumbnailer");
    expect(jobs.kinds()).toEqual([]);
  });

  it("fails activation of a plugin whose kind another plugin handles, leaving it inactive", async () => {
    const jobs = jobService();
    const host = createPluginHost({
      pluginState: state(),
      loaded: [jobPlugin("thumbnailer", ["thumbnailer:thumbnail"]), jobPlugin("copycat", ["thumbnailer:thumbnail"])],
      seedActiveIds: [],
      capabilityBindings: [jobsBinding(jobs)],
    });
    await host.init();
    await host.activate("thumbnailer");

    await expect(host.activate("copycat")).rejects.toThrow(/already handled by thumbnailer/);
    expect(host.isActive("copycat")).toBe(false);
    expect(jobs.kinds()).toEqual(["thumbnailer:thumbnail"]);
  });

  it("follows activation changes another process persisted, on refresh()", async () => {
    const rows = new Map<string, boolean>();
    const loaded = [jobPlugin("thumbnailer", ["thumbnailer:thumbnail"])];
    // The API (which serves the admin console) and a worker, over one database.
    const api = createPluginHost({ pluginState: state(rows), loaded, seedActiveIds: [] });
    const workerJobs = jobService();
    const worker = createPluginHost({
      pluginState: state(rows),
      loaded,
      seedActiveIds: [],
      capabilityBindings: [jobsBinding(workerJobs)],
    });
    await api.init();
    await worker.init();

    await api.activate("thumbnailer");
    expect(workerJobs.kinds()).toEqual([]);
    await worker.refresh();
    expect(worker.isActive("thumbnailer")).toBe(true);
    expect(workerJobs.kinds()).toEqual(["thumbnailer:thumbnail"]);

    await api.deactivate("thumbnailer");
    await worker.refresh();
    expect(worker.isActive("thumbnailer")).toBe(false);
    expect(workerJobs.kinds()).toEqual([]);
  });
});

describe("ingest guards capability binding", () => {
  it("installs a plugin's guards on activate and removes them on deactivate", async () => {
    const guards = createIngestGuardRegistry();
    const banned: LoadedPlugin = {
      ...plugin("banned-hashes", []),
      capabilities: ["ingest-guards"],
      ingestGuards: [{ check: () => ({ allow: false, reason: "banned" }) }],
    };
    const host = createPluginHost({
      pluginState: state(),
      loaded: [banned],
      seedActiveIds: [],
      capabilityBindings: [ingestGuardsBinding(guards)],
    });
    await host.init();
    expect(guards.ordered()).toEqual([]);

    await host.activate("banned-hashes");
    expect(guards.ordered().map((g) => g.ownerId)).toEqual(["banned-hashes"]);

    // Deactivating lets uploads through again at once (no restart).
    await host.deactivate("banned-hashes");
    expect(guards.ordered()).toEqual([]);
  });
});
