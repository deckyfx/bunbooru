import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createApiKeyRepository,
  createDb,
  createSettingsRepository,
  createUserRepository,
  type ApiKeyRepository,
  type DB,
  type SettingsRepository,
  type UserRepository,
} from "../src/index";

/**
 * Integration tests (opt-in `TEST_DATABASE_URL`) for the settings + api-key
 * repositories: upsert/read-back, ownership-scoped key operations, lastUsedAt,
 * and the FK behaviours (settings.updated_by → set null, api_keys → cascade).
 */
const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!TEST_DATABASE_URL)("settings + api-key repositories (integration)", () => {
  let db: DB;
  let settings: SettingsRepository;
  let apiKeys: ApiKeyRepository;
  let users: UserRepository;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL as string);
    settings = createSettingsRepository(db);
    apiKeys = createApiKeyRepository(db);
    users = createUserRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE users, settings, api_keys RESTART IDENTITY CASCADE`);
  });

  const seedUser = (username: string) =>
    users.createBootstrapping({ username, email: null, passwordHash: "h" });

  describe("SettingsRepository", () => {
    it("upserts (atomically) and reads back all overrides", async () => {
      expect(await settings.getAll()).toEqual({});

      await settings.setMany([{ key: "max_upload_bytes", value: "123" }], null);
      // A second batch overwrites the first key and adds the second.
      await settings.setMany(
        [
          { key: "max_upload_bytes", value: "456" },
          { key: "max_resumable_upload_bytes", value: "789" },
        ],
        null,
      );

      expect(await settings.getAll()).toEqual({
        max_upload_bytes: "456",
        max_resumable_upload_bytes: "789",
      });
    });

    it("keeps the setting but nulls updated_by when the editor is deleted", async () => {
      const admin = await seedUser("admin");
      await settings.setMany([{ key: "max_upload_bytes", value: "1" }], admin.id);

      // FK is ON DELETE SET NULL — the setting survives (not cascade-deleted).
      await db.execute(sql`DELETE FROM users WHERE id = ${admin.id}`);
      expect(await settings.getAll()).toEqual({ max_upload_bytes: "1" });
    });
  });

  describe("ApiKeyRepository", () => {
    it("creates, finds by hash, lists newest-first, and revokes scoped to owner", async () => {
      const alice = await seedUser("alice");
      const bob = await seedUser("bob");
      const k1 = await apiKeys.create({ userId: alice.id, name: "one", tokenHash: "h1" });
      await apiKeys.create({ userId: alice.id, name: "two", tokenHash: "h2" });
      await apiKeys.create({ userId: bob.id, name: "b", tokenHash: "h3" });

      expect(await apiKeys.findByTokenHash("h1")).toMatchObject({ id: k1.id, userId: alice.id });
      expect(await apiKeys.findByTokenHash("nope")).toBeNull();

      // Newest-first, id-tiebroken: "two" (later id) before "one".
      const aliceKeys = await apiKeys.listByUser(alice.id);
      expect(aliceKeys.map((k) => k.name)).toEqual(["two", "one"]);

      // Bob can't revoke Alice's key; Alice can.
      expect(await apiKeys.deleteByIdForUser(k1.id, bob.id)).toBe(false);
      expect(await apiKeys.deleteByIdForUser(k1.id, alice.id)).toBe(true);
      expect(await apiKeys.findByTokenHash("h1")).toBeNull();
    });

    it("touches lastUsedAt", async () => {
      const alice = await seedUser("alice");
      const key = await apiKeys.create({ userId: alice.id, name: "k", tokenHash: "h" });
      expect(key.lastUsedAt).toBeNull();

      const at = new Date("2026-05-01T00:00:00.000Z");
      await apiKeys.touchLastUsed(key.id, at);
      expect((await apiKeys.findByTokenHash("h"))?.lastUsedAt?.toISOString()).toBe(at.toISOString());
    });

    it("cascades: deleting the user removes their keys", async () => {
      const alice = await seedUser("alice");
      await apiKeys.create({ userId: alice.id, name: "k", tokenHash: "h" });

      await db.execute(sql`DELETE FROM users WHERE id = ${alice.id}`);
      expect(await apiKeys.findByTokenHash("h")).toBeNull();
    });
  });
});
