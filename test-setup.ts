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
 * The decision logic lives in `test-guard.ts` so it can be unit-tested without
 * re-running this file's side effects. Throwing here aborts the run before a
 * single connection is opened.
 */
import { unsafeTestDatabaseReason } from "./test-guard";

/**
 * Cap every pool the suites open. Each integration file builds its own handle,
 * and Bun's default of 10 connections apiece exhausts Postgres' 100-connection
 * ceiling once a dev server is also holding some (`53300: too many clients`).
 * Set explicitly in the environment to override.
 */
// `??=` alone would leave a blank value in place, and `resolvePoolMax` treats
// blank as unset — so an empty DB_POOL_MAX would silently restore Bun's default
// of 10 per handle, the exact exhaustion this line exists to prevent.
if (!Bun.env.DB_POOL_MAX?.trim()) Bun.env.DB_POOL_MAX = "3";

const reason = unsafeTestDatabaseReason(Bun.env.TEST_DATABASE_URL, Bun.env.DATABASE_URL);
if (reason !== null) throw new Error(reason);
