import type { AliasRejection, TagAlias, TagAliasRepository } from "@bunbooru/db";

import { ConflictError, ValidationError } from "../errors";
import { pageRequest, toPage, type Page } from "./paging";
import { normalizeTagName, requireTagName } from "./tag-service";

/**
 * Tag aliases: `kitty` means `cat`. Creating one migrates every post (see
 * {@link TagAliasRepository.create}); from then on tagging and search both
 * rewrite the antecedent. Admin-managed; the route layer enforces that.
 */
export interface TagAliasService {
  list(options?: { page?: number; perPage?: number }): Promise<Page<TagAlias>>;
  /**
   * Alias `antecedent` to `consequent` (raw names; normalized here). Throws
   * {@link ValidationError} for a rule violation, {@link ConflictError} when the
   * antecedent is already aliased.
   */
  create(
    antecedent: string,
    consequent: string,
    creatorId: number | null,
  ): Promise<{ alias: TagAlias; migratedPosts: number }>;
  /** Delete an alias by antecedent name; false if there was none. */
  remove(antecedent: string): Promise<boolean>;
}

/** Explain a refusal in terms an admin can act on. */
function rejectionError(reason: AliasRejection, antecedent: string, consequent: string): Error {
  switch (reason) {
    case "self":
      return new ValidationError("A tag can't be aliased to itself");
    case "exists":
      return new ConflictError(`"${antecedent}" is already aliased`);
    case "consequent-is-aliased":
      return new ValidationError(
        `"${consequent}" is itself aliased to another tag; alias "${antecedent}" to that tag instead`,
      );
    case "antecedent-is-target":
      return new ValidationError(
        `Other tags are aliased to "${antecedent}"; remove those aliases before aliasing it`,
      );
    case "antecedent-has-implications":
      return new ValidationError(
        `"${antecedent}" has implications; remove them first (they can be recreated on "${consequent}")`,
      );
  }
}

/** Build a {@link TagAliasService} over a {@link TagAliasRepository}. */
export function createTagAliasService(aliases: TagAliasRepository): TagAliasService {
  return {
    async list(options) {
      const request = pageRequest(options);
      const [items, total] = await Promise.all([
        aliases.list(request.perPage, request.offset),
        aliases.count(),
      ]);
      return toPage(items, total, request);
    },

    async create(rawAntecedent, rawConsequent, creatorId) {
      const antecedentName = requireTagName(rawAntecedent, "antecedent");
      const consequentName = requireTagName(rawConsequent, "consequent");
      const result = await aliases.create({ antecedentName, consequentName, creatorId });
      if (!result.ok) throw rejectionError(result.reason, antecedentName, consequentName);
      return { alias: result.alias, migratedPosts: result.migratedPosts };
    },

    remove(rawAntecedent) {
      const name = normalizeTagName(rawAntecedent);
      return name === null ? Promise.resolve(false) : aliases.remove(name);
    },
  };
}
