import { sql, type SQL } from "drizzle-orm";

/*
 * Drizzle expands a JS array interpolated into `sql` into a tuple (`($1, $2)`),
 * which Postgres won't cast to an array. These bind a list as ONE array-literal
 * parameter instead: still a bound value, never spliced into the SQL text.
 */

/** Integer ids as one `bigint[]` parameter. */
export function bigintArray(ids: readonly number[]): SQL {
  if (!ids.every(Number.isSafeInteger)) throw new TypeError("ids must be integers");
  return sql`${`{${ids.join(",")}}`}::bigint[]`;
}

/**
 * Strings as one `text[]` parameter. Each element is double-quoted with `"` and
 * `\` escaped, so commas, braces and quotes inside a value stay part of it.
 */
export function textArray(values: readonly string[]): SQL {
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}
