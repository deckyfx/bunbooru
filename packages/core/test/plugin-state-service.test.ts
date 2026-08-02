import { describe, expect, it } from "bun:test";

import type { PluginState, PluginStateRepository } from "@bunbooru/db";

import { createPluginStateService } from "../src/services/plugin-state-service";

/** In-memory {@link PluginStateRepository} mirroring the real upsert semantics. */
function fakeRepo(initial: Record<string, boolean> = {}): PluginStateRepository {
  const rows = new Map<string, PluginState>(
    Object.entries(initial).map(([id, active]) => [id, { id, active, updatedAt: new Date(0) }]),
  );
  return {
    getAll: async () => [...rows.values()],
    setActive: async (id, active) => {
      rows.set(id, { id, active, updatedAt: new Date() });
    },
  };
}

describe("createPluginStateService.activeIds", () => {
  it("returns only the ids whose row is active", async () => {
    const service = createPluginStateService(fakeRepo({ a: true, b: false, c: true }));
    const active = await service.activeIds();
    expect([...active].sort()).toEqual(["a", "c"]);
  });

  it("is empty on a fresh install (no rows)", async () => {
    const service = createPluginStateService(fakeRepo());
    expect((await service.activeIds()).size).toBe(0);
  });
});

describe("createPluginStateService.setActive", () => {
  it("persists a plugin's on/off state", async () => {
    const repo = fakeRepo();
    const service = createPluginStateService(repo);
    await service.setActive("thumbnailer", true);
    expect([...(await service.activeIds())]).toEqual(["thumbnailer"]);
    await service.setActive("thumbnailer", false);
    expect((await service.activeIds()).size).toBe(0);
  });
});

describe("createPluginStateService.seedIfEmpty", () => {
  it("seeds the given ids as active ONLY when the table is empty", async () => {
    const service = createPluginStateService(fakeRepo());
    const seeded = await service.seedIfEmpty(["a", "b", "a"]); // de-duped
    expect(seeded).toBe(true);
    expect([...(await service.activeIds())].sort()).toEqual(["a", "b"]);
  });

  it("is a no-op once any row exists (never fights an admin's toggles)", async () => {
    // b is explicitly OFF; seeding must NOT re-enable a/b.
    const service = createPluginStateService(fakeRepo({ b: false }));
    const seeded = await service.seedIfEmpty(["a", "b"]);
    expect(seeded).toBe(false);
    expect((await service.activeIds()).size).toBe(0);
  });
});
