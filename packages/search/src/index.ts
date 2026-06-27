/**
 * `@bunbooru/search` — the search engine: lexer → parser → AST → optimizer → SQL builder.
 *
 * Pure and self-contained: no HTTP, no Drizzle, no database. The AST is the
 * canonical representation; everything downstream consumes it. The pipeline
 * implementation lands in a later PR.
 */
export const SEARCH_PACKAGE = "@bunbooru/search" as const;
