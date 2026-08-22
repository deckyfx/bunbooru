import { describe, expect, it } from "bun:test";

import type { PluginTable, PluginTableRepository } from "@bunbooru/db";

import { createPluginCatalogService } from "../src/services/plugin-catalog-service";

/** In-memory {@link PluginTableRepository}: replace-all per plugin, like the real one. */
function fakeRepo(): PluginTableRepository {
  let rows: PluginTable[] = [];
  return {
    async getAll() {
      return rows.map((r) => ({ ...r }));
    },
    async setForPlugin(pluginId, tableNames) {
      rows = rows.filter((r) => r.pluginId !== pluginId);
      for (const tableName of tableNames) {
        rows.push({ pluginId, tableName, createdAt: new Date(0) });
      }
    },
    async setAll(records) {
      const ids = new Set(records.map((r) => r.pluginId));
      rows = rows.filter((r) => !ids.has(r.pluginId));
      for (const { pluginId, tableNames } of records) {
        for (const tableName of tableNames) {
          rows.push({ pluginId, tableName, createdAt: new Date(0) });
        }
      }
    },
  };
}

describe("createPluginCatalogService", () => {
  it("records a plugin's tables and lists them grouped + sorted", async () => {
    const service = createPluginCatalogService(fakeRepo());
    await service.record("smtp-mailer", ["mail_settings", "mail_outbox"]);
    await service.record("thumbnailer", ["thumbnails"]);

    expect(await service.list()).toEqual([
      { pluginId: "smtp-mailer", tables: ["mail_outbox", "mail_settings"] }, // sorted
      { pluginId: "thumbnailer", tables: ["thumbnails"] },
    ]);
  });

  it("de-dupes declared names and replaces a plugin's set on re-record", async () => {
    const service = createPluginCatalogService(fakeRepo());
    await service.record("p", ["a", "a", "b"]);
    await service.record("p", ["c"]); // replaces — 'a'/'b' gone

    expect(await service.list()).toEqual([{ pluginId: "p", tables: ["c"] }]);
  });

  it("recording an empty set clears a plugin's tables", async () => {
    const service = createPluginCatalogService(fakeRepo());
    await service.record("p", ["a"]);
    await service.record("p", []);

    expect(await service.list()).toEqual([]);
  });

  it("recordAll writes many plugins at once (de-duped), preserving unlisted ones", async () => {
    const service = createPluginCatalogService(fakeRepo());
    await service.record("keep", ["k"]);
    await service.recordAll([
      { pluginId: "p1", tables: ["a", "a"] }, // de-duped
      { pluginId: "p2", tables: ["b"] },
    ]);

    expect(await service.list()).toEqual([
      { pluginId: "keep", tables: ["k"] },
      { pluginId: "p1", tables: ["a"] },
      { pluginId: "p2", tables: ["b"] },
    ]);
  });

  it("recordAll merges repeated plugin ids into one de-duplicated set", async () => {
    const service = createPluginCatalogService(fakeRepo());
    await service.recordAll([
      { pluginId: "p", tables: ["a", "b"] },
      { pluginId: "p", tables: ["b", "c"] }, // same id → merged, 'b' de-duped
    ]);

    expect(await service.list()).toEqual([{ pluginId: "p", tables: ["a", "b", "c"] }]);
  });
});
