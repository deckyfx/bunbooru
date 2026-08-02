import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createDb,
  createPluginStateRepository,
  type DB,
  type PluginStateRepository,
} from "../src/index";

/**
 * Integration tests against a real Postgres (see asset-repository.test for the
 * opt-in `TEST_DATABASE_URL` rationale). These lock down the plugin-state
 * upsert: repeated `setActive` for one id keeps a single row and flips its flag.
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!TEST_DATABASE_URL)("PluginStateRepository (integration)", () => {
  let db: DB;
  let repo: PluginStateRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    repo = createPluginStateRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE plugin_states RESTART IDENTITY`);
  });

  it("starts empty", async () => {
    expect(await repo.getAll()).toEqual([]);
  });

  it("inserts a row and reads it back", async () => {
    await repo.setActive("shimmie-import", true);
    const rows = await repo.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("shimmie-import");
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("upserts on conflict — one row per id, flipping the flag", async () => {
    await repo.setActive("thumbnailer", true);
    await repo.setActive("thumbnailer", false); // same id → update, not a 2nd row
    const rows = await repo.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.active).toBe(false);
  });

  it("tracks independent plugins separately", async () => {
    await repo.setActive("a", true);
    await repo.setActive("b", false);
    const byId = Object.fromEntries((await repo.getAll()).map((r) => [r.id, r.active]));
    expect(byId).toEqual({ a: true, b: false });
  });
});
