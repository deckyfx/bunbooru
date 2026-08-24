/**
 * Test preload guard — runs ONCE before any test file (see `bunfig.toml`).
 *
 * The integration suites opt in via `TEST_DATABASE_URL` and `TRUNCATE` the tables
 * they exercise in `beforeEach`. Pointed at a real database, that silently
 * destroys it: this repo lost its dev users, assets and sessions exactly that way
 * (the plugin_states rows `a`/`b` are the fingerprints it left behind).
 *
 * A preload is used rather than a helper the suites import because it CANNOT be
 * forgotten: ten test files across `packages/` and `plugins/` read the variable
 * independently, and `plugins/*` may not import `@bunbooru/db` (dependency rule),
 * so there is no single module all of them could share. This runs first, for all
 * of them, whatever they import.
 *
 * Throwing here aborts the run before a single connection is opened.
 */

/**
 * Cap every pool the suites open. Each integration file builds its own handle,
 * and Bun's default of 10 connections apiece exhausts Postgres' 100-connection
 * ceiling once a dev server is also holding some (`53300: too many clients`).
 * Set explicitly in the environment to override.
 */
Bun.env.DB_POOL_MAX ??= "3";

/** Local aliases that address the same server, so they compare equal. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `host:port/database`, credentials stripped — what makes two URLs the same target. */
function target(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // Unparseable: let the suite's own connection surface it.
  }
  const host = LOOPBACK.has(url.hostname) ? "localhost" : url.hostname;
  const port = url.port || "5432";
  return `${host}:${port}${url.pathname}`;
}

/** The database name from a connection URL (`/bunbooru_test` → `bunbooru_test`). */
function databaseName(raw: string): string | null {
  try {
    const name = new URL(raw).pathname.replace(/^\//, "");
    return name || null;
  } catch {
    return null;
  }
}

const testUrl = Bun.env.TEST_DATABASE_URL?.trim();

if (testUrl) {
  const devUrl = Bun.env.DATABASE_URL?.trim();
  const testTarget = target(testUrl);

  // 1. Never the same database the app runs on, however it is spelled.
  if (devUrl && testTarget !== null && testTarget === target(devUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as DATABASE_URL (${testTarget}).\n` +
        "The integration tests TRUNCATE the tables they touch — this would destroy your data.\n" +
        "Point TEST_DATABASE_URL at a throwaway database (e.g. bunbooru_test).",
    );
  }

  // 2. Belt and braces: the name must look like a test database, so an unset
  //    DATABASE_URL (a bare shell, CI) can't slip past rule 1.
  const name = databaseName(testUrl);
  if (name !== null && !name.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL database "${name}" does not end in "_test".\n` +
        "The integration tests TRUNCATE the tables they touch, so they only run against\n" +
        "a database whose name marks it as disposable. Rename it, or point at bunbooru_test.",
    );
  }
}
