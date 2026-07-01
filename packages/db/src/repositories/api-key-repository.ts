import { and, desc, eq } from "drizzle-orm";

import { apiKeys, type ApiKey, type NewApiKey } from "../schema";
import type { DB } from "../client";

/**
 * Data access for {@link ApiKey} rows (the sole SQL layer per CLAUDE.md). Keys
 * are looked up by the sha256 hash of the opaque token (the raw `bnb_…` token
 * never touches the DB), mirroring the session store.
 */
export interface ApiKeyRepository {
  /** Insert a key, returning the persisted row. */
  create(input: NewApiKey): Promise<ApiKey>;
  /** The key for a token hash, or null (no expiry — valid until revoked). */
  findByTokenHash(tokenHash: string): Promise<ApiKey | null>;
  /** A user's keys, newest first. */
  listByUser(userId: number): Promise<ApiKey[]>;
  /** Revoke a key, scoped to its owner; true if a row was deleted. */
  deleteByIdForUser(id: number, userId: number): Promise<boolean>;
  /** Best-effort activity timestamp bump on use. */
  touchLastUsed(id: number, at: Date): Promise<void>;
}

/** Build an {@link ApiKeyRepository} over a {@link DB} handle. */
export function createApiKeyRepository(db: DB): ApiKeyRepository {
  return {
    async create(input) {
      const [row] = await db.insert(apiKeys).values(input).returning();
      if (!row) {
        throw new Error("api key insert returned no row");
      }
      return row;
    },

    async findByTokenHash(tokenHash) {
      const [row] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    },

    async listByUser(userId) {
      return db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId))
        // `id` is the tiebreaker so equal-timestamp keys have a stable order.
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
    },

    async deleteByIdForUser(id, userId) {
      const rows = await db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    },

    async touchLastUsed(id, at) {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
    },
  };
}
