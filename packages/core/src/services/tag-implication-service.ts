import type { ImplicationRejection, TagImplication, TagImplicationRepository } from "@bunbooru/db";

import { ConflictError, ValidationError } from "../errors";
import { pageRequest, toPage, type Page } from "./paging";
import { normalizeTagName, requireTagName } from "./tag-service";

/**
 * Tag implications: a post tagged `cat` is also tagged `animal`. Implied tags are
 * materialized onto posts, at tag time and once for existing posts when the
 * implication is created. Admin-managed; the route layer enforces that.
 */
export interface TagImplicationService {
  list(options?: { page?: number; perPage?: number }): Promise<Page<TagImplication>>;
  /**
   * Make `antecedent` imply `consequent` (raw names; normalized here) and
   * backfill existing posts. Throws {@link ValidationError} for a rule violation,
   * {@link ConflictError} when the pair already exists.
   */
  create(
    antecedent: string,
    consequent: string,
    creatorId: number | null,
  ): Promise<{ implication: TagImplication; backfilledPosts: number }>;
  /** Delete an implication; false if there was none. Tags it already added stay. */
  remove(antecedent: string, consequent: string): Promise<boolean>;
}

/** Explain a refusal in terms an admin can act on. */
function rejectionError(reason: ImplicationRejection, antecedent: string, consequent: string): Error {
  switch (reason) {
    case "self":
      return new ValidationError("A tag can't imply itself");
    case "exists":
      return new ConflictError(`"${antecedent}" already implies "${consequent}"`);
    case "cycle":
      return new ValidationError(
        `"${consequent}" already implies "${antecedent}" (directly or through other tags), so this would create a loop`,
      );
    case "aliased":
      return new ValidationError(
        "One of these tags is an alias; use the tag it's aliased to instead",
      );
  }
}

/** Build a {@link TagImplicationService} over a {@link TagImplicationRepository}. */
export function createTagImplicationService(
  implications: TagImplicationRepository,
): TagImplicationService {
  return {
    async list(options) {
      const request = pageRequest(options);
      const [items, total] = await Promise.all([
        implications.list(request.perPage, request.offset),
        implications.count(),
      ]);
      return toPage(items, total, request);
    },

    async create(rawAntecedent, rawConsequent, creatorId) {
      const antecedentName = requireTagName(rawAntecedent, "antecedent");
      const consequentName = requireTagName(rawConsequent, "consequent");
      const result = await implications.create({ antecedentName, consequentName, creatorId });
      if (!result.ok) throw rejectionError(result.reason, antecedentName, consequentName);
      return { implication: result.implication, backfilledPosts: result.backfilledPosts };
    },

    remove(rawAntecedent, rawConsequent) {
      const antecedent = normalizeTagName(rawAntecedent);
      const consequent = normalizeTagName(rawConsequent);
      if (antecedent === null || consequent === null) return Promise.resolve(false);
      return implications.remove(antecedent, consequent);
    },
  };
}
