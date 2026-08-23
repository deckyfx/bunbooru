import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import type { DB } from "./client";
import { embeddedMigrations as coreEmbedded, embeddedMigrationCount as coreCount } from "./migrations.embedded";

/**
 * A package's migrations embedded into the compiled binary: the `_journal.json`
 * as a string, and every `<tag>.sql` by filename. Produced by
 * `scripts/embed-migrations.ts` via build-time `with { type: "text"/"json" }`
 * imports (see BUN_DATABASE.md), so the binary carries its SQL with no `drizzle/`
 * folder on disk.
 */
export interface EmbeddedMigrations {
  /** JSON string of `meta/_journal.json`. */
  journal: string;
  /** `<tag>.sql` → raw SQL text. */
  files: Record<string, string>;
}

/** One journal entry (the fields we use). */
interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Config for {@link applyEmbeddedMigrations}. */
export interface EmbeddedMigrationConfig {
  /** The embedded journal + SQL (a package's `migrations.embedded.ts`). */
  embedded: EmbeddedMigrations;
  /** Tracking table (Drizzle default `__drizzle_migrations`; plugins pass their own). */
  migrationsTable?: string;
  /** Tracking schema (Drizzle default `drizzle`). */
  migrationsSchema?: string;
  /** Short label for logs + the materialise temp dir (e.g. `core`, `smtp-mailer`). */
  label: string;
}

const DEFAULT_TABLE = "__drizzle_migrations";
const DEFAULT_SCHEMA = "drizzle";

/** Fixed advisory-lock key serializing CORE boot migrations across replicas. */
const CORE_MIGRATION_LOCK_KEY = 4_010_202_507;

/** sha256 of a migration's raw SQL — matches how Drizzle records `hash`. */
function hashSql(rawSql: string): string {
  return createHash("sha256").update(rawSql).digest("hex");
}

/** The build's migration sequence (order + timestamp + hash), from the journal. */
function buildSequence(embedded: EmbeddedMigrations): { when: number; tag: string; hash: string }[] {
  const journal = JSON.parse(embedded.journal) as { entries: JournalEntry[] };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const raw = embedded.files[`${e.tag}.sql`];
      if (raw === undefined) {
        throw new Error(`embedded journal names "${e.tag}" but no ${e.tag}.sql was compiled in`);
      }
      return { when: e.when, tag: e.tag, hash: hashSql(raw) };
    });
}

/**
 * Preflight against the recorded migrations, returning the pending count and
 * refusing to run when the database disagrees with this build in a DANGEROUS way.
 *
 * Drizzle applies migrations whose journal `when` exceeds the single greatest
 * recorded `created_at`, and never inspects individual hashes — so on its own it
 * would silently SKIP a build migration sitting below that high-water mark (see
 * BUN_DATABASE.md trap 7/8). We guard both real hazards:
 *  - **Downgrade**: the DB's high-water mark is newer than anything this build
 *    carries → this build is older than the database → fatal.
 *  - **Gap**: a build migration at/below the high-water mark isn't applied →
 *    Drizzle would skip it → fatal.
 *
 * We deliberately TOLERATE recorded rows whose hash isn't in this build as long
 * as they sit at/below the high-water mark: those are superseded history (e.g. an
 * early migration later renumbered/regenerated), harmless and common on a
 * long-lived database. A naive "applied must be an ordered prefix" check would
 * false-positive on them.
 */
async function preflight(
  db: DB,
  buildSeq: { when: number; tag: string; hash: string }[],
  schema: string,
  table: string,
): Promise<number> {
  let rows: { hash: string; created_at: unknown }[] = [];
  try {
    const result = await db.execute(
      sql`select hash, created_at from ${sql.identifier(schema)}.${sql.identifier(table)} order by created_at asc`,
    );
    // bun-sql returns an array-like of row objects.
    rows = result as unknown as { hash: string; created_at: unknown }[];
  } catch {
    // Tracking table/schema absent → nothing applied yet (fresh database).
    rows = [];
  }

  return planMigrations(
    rows.map((r) => ({ hash: r.hash, when: Number(r.created_at) })),
    buildSeq,
    `${schema}.${table}`,
  );
}

/**
 * Pure migration-state check (no DB): given the APPLIED rows and this build's
 * sequence, return the pending count or throw on a dangerous mismatch. Extracted
 * so the downgrade/gap/orphan-tolerance rules are unit-testable. See {@link preflight}.
 */
export function planMigrations(
  applied: { hash: string; when: number }[],
  buildSeq: { when: number; tag: string; hash: string }[],
  label = "migrations",
): number {
  if (applied.length === 0) return buildSeq.length; // fresh DB → everything pending

  const appliedHashes = new Set(applied.map((r) => r.hash));
  const dbMaxWhen = Math.max(...applied.map((r) => r.when));
  const buildMaxWhen = Math.max(...buildSeq.map((b) => b.when));

  // Downgrade: the database has a migration newer than this build knows about.
  if (dbMaxWhen > buildMaxWhen) {
    throw new Error(
      `${label}: the database has migration(s) newer than this build ` +
        `(recorded created_at ${dbMaxWhen} > build max ${buildMaxWhen}) — this build is older ` +
        `than the database; restore a newer build or downgrade deliberately.`,
    );
  }
  // Gap: any build migration at/below the DB high-water mark must already be
  // applied, or Drizzle's max-only comparison will skip it forever.
  for (const b of buildSeq) {
    if (b.when <= dbMaxWhen && !appliedHashes.has(b.hash)) {
      throw new Error(
        `${label}: build migration "${b.tag}" (when ${b.when}) is not applied, ` +
          `but the database is already past it — schema gap.`,
      );
    }
  }
  // Pending = build migrations strictly newer than the DB high-water mark
  // (exactly what Drizzle's migrator will now apply). Superseded orphan rows
  // (hash not in the build, at/below the high-water mark) are tolerated.
  return buildSeq.filter((b) => b.when > dbMaxWhen).length;
}

/**
 * Materialise the embedded SQL to a FRESH, unique temp dir so Drizzle's own
 * migrator can run against it (we don't re-implement Drizzle's tracking — see the
 * guide). A unique dir per call means concurrent invocations (e.g. plugins
 * starting together) can never overwrite each other's journal or prune each
 * other's SQL mid-migrate. The caller removes it when done.
 */
async function materialise(embedded: EmbeddedMigrations, label: string): Promise<string> {
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = await mkdtemp(join(tmpdir(), `bunbooru-mig-${safe}-`));
  await Bun.write(join(dir, "meta", "_journal.json"), embedded.journal);
  for (const [name, contents] of Object.entries(embedded.files)) {
    await Bun.write(join(dir, name), contents);
  }
  return dir;
}

/**
 * Apply a package's EMBEDDED migrations to `db`: preflight (ordered-prefix check)
 * → materialise the embedded SQL to a temp dir → run Drizzle's migrator against
 * it. Idempotent; existing databases re-run nothing (Drizzle's `__drizzle_migrations`
 * bookkeeping is preserved). Throws on an empty set (a packaging fault) or a
 * database that diverges from / is ahead of this build.
 */
export async function applyEmbeddedMigrations(db: DB, config: EmbeddedMigrationConfig): Promise<void> {
  const table = config.migrationsTable ?? DEFAULT_TABLE;
  const schema = config.migrationsSchema ?? DEFAULT_SCHEMA;

  const buildSeq = buildSequence(config.embedded);
  if (buildSeq.length === 0) {
    throw new Error(`No migrations were compiled in for "${config.label}" — packaging fault.`);
  }

  await preflight(db, buildSeq, schema, table);
  const migrationsFolder = await materialise(config.embedded, config.label);
  try {
    await migrate(db, { migrationsFolder, migrationsTable: table, migrationsSchema: schema });
  } finally {
    await rm(migrationsFolder, { recursive: true, force: true });
  }
}

/**
 * Run `fn` against a DEDICATED single connection under a Postgres session
 * advisory lock, so the lock + migration share one session and concurrent
 * replicas booting together can't run the same DDL. The connection is always
 * closed afterward.
 */
async function withMigrationConnection(
  url: string,
  lockKey: number,
  fn: (db: DB) => Promise<void>,
): Promise<void> {
  const client = new SQL(url, { max: 1 });
  const db = drizzle({ client }) as unknown as DB;
  try {
    await db.execute(sql`SELECT pg_advisory_lock(${lockKey})`);
    try {
      await fn(db);
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${lockKey})`);
    }
  } finally {
    await client.close();
  }
}

/**
 * Apply all pending CORE migrations on boot — from the SQL embedded in the binary
 * (no `drizzle/` folder needed at runtime). Advisory-locked on a dedicated
 * connection so multiple replicas booting at once are safe.
 */
export async function applyCoreMigrations(url: string): Promise<void> {
  if (coreCount === 0) {
    throw new Error("No core migrations were compiled into this build — the database cannot be created.");
  }
  await withMigrationConnection(url, CORE_MIGRATION_LOCK_KEY, (db) =>
    applyEmbeddedMigrations(db, { embedded: coreEmbedded, label: "core" }),
  );
}
