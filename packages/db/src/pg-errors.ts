/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Walk the error's cause chain for a Postgres unique-violation. The SQLSTATE
 * lives in different fields per driver: node-postgres exposes it as `.code`,
 * while Bun's native SQL driver puts it in `.errno` (with `.code` set to the
 * generic `"ERR_POSTGRES_SERVER_ERROR"`) and wraps the real error under `.cause`.
 * Accept either field, at any depth.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e !== null && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const record = e as { code?: unknown; errno?: unknown };
    if (record.code === PG_UNIQUE_VIOLATION || record.errno === PG_UNIQUE_VIOLATION) return true;
  }
  return false;
}
