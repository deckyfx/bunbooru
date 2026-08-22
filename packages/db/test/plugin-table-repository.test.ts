import { beforeAll, beforeEach, describe, expect, it } from "bun:test";

import {
  createDb,
  createPluginTableRepository,
  pluginTables,
  type DB,
  type PluginTableRepository,
} from "../src/index";

/**
 * Integration tests against a real Postgres (migrations already applied). Opt-in
 * via `TEST_DATABASE_URL` (a DEDICATED database — TRUNCATEd between cases), never
 * the app's `DATABASE_URL`. Skipped when unset so a bare `bun test` stays green.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!TEST_DATABASE_URL)("PluginTableRepository (integration)", () => {
  let db: DB;
  let repo: PluginTableRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    repo = createPluginTableRepository(db);
  });

  beforeEach(async () => {
    await db.delete(pluginTables);
  });

  const key = (r: { pluginId: string; tableName: string }) => `${r.pluginId}.${r.tableName}`;

  it("starts empty", async () => {
    expect(await repo.getAll()).toEqual([]);
  });

  it("setForPlugin records a plugin's tables", async () => {
    await repo.setForPlugin("smtp-mailer", ["mail_outbox", "mail_settings"]);
    const rows = await repo.getAll();
    expect(rows.map((r) => r.tableName).sort()).toEqual(["mail_outbox", "mail_settings"]);
    expect(rows.every((r) => r.pluginId === "smtp-mailer")).toBe(true);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("setForPlugin replaces the set (delete-before-insert), not appends", async () => {
    await repo.setForPlugin("p", ["a", "b"]);
    await repo.setForPlugin("p", ["c"]);
    expect((await repo.getAll()).map((r) => r.tableName)).toEqual(["c"]);
  });

  it("setForPlugin with an empty list clears the plugin", async () => {
    await repo.setForPlugin("p", ["a"]);
    await repo.setForPlugin("p", []);
    expect(await repo.getAll()).toEqual([]);
  });

  it("setAll replaces the given plugins atomically, preserving others", async () => {
    await repo.setForPlugin("keep", ["k"]);
    await repo.setAll([
      { pluginId: "p1", tableNames: ["a"] },
      { pluginId: "p2", tableNames: ["b"] },
    ]);
    const rows = await repo.getAll();
    expect(rows.map(key).sort()).toEqual(["keep.k", "p1.a", "p2.b"]);
  });

  it("setAll re-records: a plugin's prior rows are replaced, unlisted plugins untouched", async () => {
    await repo.setAll([
      { pluginId: "keep", tableNames: ["k"] },
      { pluginId: "p", tableNames: ["a", "b"] },
    ]);
    await repo.setAll([{ pluginId: "p", tableNames: ["c"] }]);
    const rows = await repo.getAll();
    expect(rows.map(key).sort()).toEqual(["keep.k", "p.c"]);
  });
});
