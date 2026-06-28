/**
 * `@bunbooru/search` — the search engine: lexer → parser → AST → optimizer → SQL builder.
 *
 * Pure and self-contained: no HTTP, no Drizzle, no database. The AST is the
 * canonical representation; everything downstream consumes it. The optimizer and
 * SQL builder land once the DB exists.
 */
export const SEARCH_PACKAGE = "@bunbooru/search" as const;

export { tokenize } from "./token";
export type { Prefix, Token, TagToken, MetatagToken } from "./token";

export { parse } from "./parser";
export type {
  AndNode,
  CompareOp,
  MetatagNode,
  NotNode,
  OrNode,
  QueryNode,
  TagNode,
} from "./ast";
