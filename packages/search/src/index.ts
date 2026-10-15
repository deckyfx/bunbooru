/**
 * `@bunbooru/search` — the search engine: lexer → parser → AST → optimizer → SQL builder.
 *
 * Pure and self-contained: no HTTP, no Drizzle, no database. The AST is the
 * canonical representation; everything downstream consumes it. The optimizer
 * takes the database-derived facts it needs (aliases) as plain data, and the SQL
 * builder lives in Core, next to the schema it targets.
 */
export const SEARCH_PACKAGE = "@bunbooru/search" as const;

export { tokenize } from "./token";
export type { Prefix, Token, TagToken, MetatagToken } from "./token";

export { parse } from "./parser";

export { collectTagNames, optimize } from "./optimizer";
export type { OptimizeOptions } from "./optimizer";
export type {
  AndNode,
  CompareOp,
  MetatagNode,
  NotNode,
  OrNode,
  QueryNode,
  TagNode,
} from "./ast";
