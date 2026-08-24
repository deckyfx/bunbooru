/**
 * Pure helpers behind the test-database guard (see `test-setup.ts`).
 *
 * Kept separate from the preload so they can be unit-tested WITHOUT re-running
 * the guard: importing `test-setup.ts` would execute its env checks a second
 * time, and a test asserting the failure cases would then have to corrupt the
 * real environment to do it.
 */

/**
 * Whether `host` addresses the local machine.
 *
 * The whole `127.0.0.0/8` block is loopback, not just `127.0.0.1` — so a dev URL
 * on `127.0.0.1` and a test URL on `127.0.0.2` reach the same Postgres. Matching
 * only the canonical spelling would let that pair slip past the same-database
 * check and truncate a real database.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/**
 * `host:port/database` with credentials stripped — what makes two connection
 * URLs the same target. Returns null when the URL doesn't parse, so the caller
 * can defer to the suite's own connection error rather than guessing.
 */
export function target(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = isLoopbackHost(url.hostname) ? "localhost" : url.hostname;
  const port = url.port || "5432";
  return `${host}:${port}${url.pathname}`;
}

/** The database name from a connection URL (`/bunbooru_test` → `bunbooru_test`). */
export function databaseName(raw: string): string | null {
  try {
    const name = new URL(raw).pathname.replace(/^\//, "");
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Why a `TEST_DATABASE_URL` was rejected, or null when it is safe to use.
 *
 * Returns the reason rather than throwing so it is testable without catching:
 * the preload turns a non-null result into the thrown error.
 */
export function unsafeTestDatabaseReason(
  testUrl: string | undefined,
  devUrl: string | undefined,
): string | null {
  const test = testUrl?.trim();
  if (!test) return null; // Unset → the integration suites skip entirely.

  // 1. Never the same database the app runs on, however it is spelled.
  const testTarget = target(test);
  const dev = devUrl?.trim();
  if (dev && testTarget !== null && testTarget === target(dev)) {
    return (
      `TEST_DATABASE_URL points at the same database as DATABASE_URL (${testTarget}).\n` +
      "The integration tests TRUNCATE the tables they touch — this would destroy your data.\n" +
      "Point TEST_DATABASE_URL at a throwaway database (e.g. bunbooru_test)."
    );
  }

  // 2. Belt and braces: the name must look like a test database, so an unset
  //    DATABASE_URL (a bare shell, CI) can't slip past rule 1.
  const name = databaseName(test);
  if (name !== null && !name.endsWith("_test")) {
    return (
      `TEST_DATABASE_URL database "${name}" does not end in "_test".\n` +
      "The integration tests TRUNCATE the tables they touch, so they only run against\n" +
      "a database whose name marks it as disposable. Rename it, or point at bunbooru_test."
    );
  }

  return null;
}
