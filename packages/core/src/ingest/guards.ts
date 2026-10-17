import { IngestCheckFailedError, IngestRejectedError } from "../errors";

/**
 * What an ingest guard sees: the upload's content hashes and size, who sent
 * it, and its bytes (lazy: a hash-based guard never reads them). Runs BEFORE
 * dedupe, so a banned file can't slip in as a copy of one already stored.
 */
export interface IngestCandidate {
  /** sha256 of the bytes as received. */
  readonly sha256: string;
  /** md5 of the bytes as received (booru ban lists are often md5-keyed). */
  readonly md5: string;
  readonly sizeBytes: number;
  readonly uploaderId: number | null;
  /** The post's source URL, when the uploader gave one. */
  readonly source: string | null;
  readonly blob: Blob;
  /** Aborted when the guard's time is up: stop work and return. */
  readonly signal: AbortSignal;
}

/** A guard's answer. `reason` is shown to the uploader. */
export type IngestVerdict = { allow: true } | { allow: false; reason: string };

/**
 * A check every upload must pass before it's stored, from every source (one-shot,
 * resumable, importers). Fails CLOSED: a guard that throws or overruns its
 * timeout refuses the upload ({@link IngestCheckFailedError}).
 */
export interface IngestGuard {
  check(candidate: IngestCandidate): Promise<IngestVerdict> | IngestVerdict;
  /** Run order, ascending (default 0); ties break by owner, then position. */
  order?: number;
}

/** Thrown by {@link IngestGuardRegistry.register} for an invalid guard. */
export class IngestGuardRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestGuardRegistrationError";
  }
}

/** A guard with its owner, as the pipeline runs it. */
export interface RegisteredIngestGuard {
  ownerId: string;
  guard: IngestGuard;
}

/** Read access to the active guards, in run order — what the ingest pipeline needs. */
export interface IngestGuardList {
  ordered(): readonly RegisteredIngestGuard[];
}

/**
 * The live set of ingest guards. The API's plugin host registers a plugin's
 * guards when it activates and removes them when it deactivates, so an admin
 * can switch a misbehaving guard off without a restart.
 */
export interface IngestGuardRegistry extends IngestGuardList {
  /** Install `guards` for `ownerId`, replacing its previous set. All-or-nothing. */
  register(ownerId: string, guards: readonly IngestGuard[]): void;
  /** Remove every guard `ownerId` registered (no-op if none). */
  unregister(ownerId: string): void;
}

/** Build an empty {@link IngestGuardRegistry}. */
export function createIngestGuardRegistry(): IngestGuardRegistry {
  const byOwner = new Map<string, readonly IngestGuard[]>();
  // Rebuilt on change, not per upload: uploads read it far more often.
  let sorted: RegisteredIngestGuard[] = [];

  const rebuild = (): void => {
    sorted = [...byOwner]
      .flatMap(([ownerId, guards]) => guards.map((guard, index) => ({ ownerId, guard, index })))
      .sort(
        (a, b) =>
          (a.guard.order ?? 0) - (b.guard.order ?? 0) ||
          (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0) ||
          a.index - b.index,
      )
      .map(({ ownerId, guard }) => ({ ownerId, guard }));
  };

  return {
    register(ownerId, guards) {
      for (const guard of guards) {
        if (guard.order !== undefined && !Number.isFinite(guard.order)) {
          throw new IngestGuardRegistrationError(`An ingest guard from ${ownerId} has a non-finite order`);
        }
      }
      if (guards.length === 0) byOwner.delete(ownerId);
      else byOwner.set(ownerId, [...guards]);
      rebuild();
    },
    unregister(ownerId) {
      if (byOwner.delete(ownerId)) rebuild();
    },
    ordered() {
      return sorted;
    },
  };
}

/** How long one guard may take (the design's default). */
export const INGEST_GUARD_TIMEOUT_MS = 5000;

/**
 * Run every guard, in order, against `candidate` (built per guard, so each
 * gets its own abort signal). The first refusal wins:
 * {@link IngestRejectedError}. A guard that throws, returns something that
 * isn't a verdict, or overruns `timeoutMs` (its signal is aborted) fails the
 * upload closed: {@link IngestCheckFailedError}. No guards: resolves at once.
 */
export async function runIngestGuards(
  guards: IngestGuardList,
  candidate: Omit<IngestCandidate, "signal">,
  timeoutMs = INGEST_GUARD_TIMEOUT_MS,
): Promise<void> {
  for (const { ownerId, guard } of guards.ordered()) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let verdict: IngestVerdict;
    try {
      verdict = await Promise.race([
        Promise.resolve().then(() => guard.check({ ...candidate, signal: controller.signal })),
        timedOut,
      ]);
    } catch (error) {
      throw new IngestCheckFailedError(ownerId, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (verdict?.allow === true) continue;
    if (verdict?.allow === false && typeof verdict.reason === "string") {
      throw new IngestRejectedError(verdict.reason, ownerId);
    }
    throw new IngestCheckFailedError(ownerId, { cause: new Error("the guard returned no verdict") });
  }
}
