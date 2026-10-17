import { describe, expect, it } from "bun:test";

import { IngestCheckFailedError, IngestRejectedError } from "../src/errors";
import { createIngestGuardRegistry, runIngestGuards, type IngestGuard } from "../src/ingest/guards";

const candidate = {
  sha256: "a".repeat(64),
  md5: "b".repeat(32),
  sizeBytes: 3,
  uploaderId: 1,
  source: null,
  blob: new Blob([new Uint8Array([1, 2, 3])]),
};

const allow: IngestGuard = { check: () => ({ allow: true }) };

/** A guard that records its run under `label` and allows. */
const tracer = (label: string, ran: string[], order?: number): IngestGuard => ({
  order,
  check: () => {
    ran.push(label);
    return { allow: true };
  },
});

describe("IngestGuardRegistry", () => {
  it("orders by `order`, then owner, then registration position", () => {
    const registry = createIngestGuardRegistry();
    const ran: string[] = [];
    registry.register("zeta", [tracer("zeta-1", ran), tracer("zeta-early", ran, -5)]);
    registry.register("alpha", [tracer("alpha-1", ran), tracer("alpha-2", ran)]);
    expect(registry.ordered().map((g) => g.ownerId)).toEqual(["zeta", "alpha", "alpha", "zeta"]);
    return runIngestGuards(registry, candidate).then(() => {
      expect(ran).toEqual(["zeta-early", "alpha-1", "alpha-2", "zeta-1"]);
    });
  });

  it("replaces an owner's set on re-register, and unregisters it", () => {
    const registry = createIngestGuardRegistry();
    registry.register("a", [allow, allow]);
    registry.register("a", [allow]);
    expect(registry.ordered()).toHaveLength(1);
    registry.unregister("a");
    expect(registry.ordered()).toEqual([]);
  });

  it("refuses a non-finite order, changing nothing", () => {
    const registry = createIngestGuardRegistry();
    registry.register("a", [allow]);
    expect(() => registry.register("a", [{ ...allow, order: Number.NaN }])).toThrow(/non-finite/);
    expect(registry.ordered()).toHaveLength(1);
  });
});

describe("runIngestGuards", () => {
  it("passes with no guards, or when every guard allows", async () => {
    await runIngestGuards(createIngestGuardRegistry(), candidate);
    const registry = createIngestGuardRegistry();
    registry.register("a", [allow, allow]);
    await runIngestGuards(registry, candidate);
  });

  it("stops at the first refusal, carrying its reason and owner", async () => {
    const registry = createIngestGuardRegistry();
    const ran: string[] = [];
    registry.register("bans", [{ check: () => ({ allow: false, reason: "This file is banned" }) }]);
    registry.register("later", [tracer("later", ran, 10)]);
    const error = await runIngestGuards(registry, candidate).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestRejectedError);
    expect(error).toMatchObject({ message: "This file is banned", ownerId: "bans" });
    expect(ran).toEqual([]);
  });

  it("hands each guard the candidate", async () => {
    const registry = createIngestGuardRegistry();
    let seen: unknown;
    registry.register("a", [{ check: (c) => ((seen = { sha256: c.sha256, md5: c.md5, size: c.sizeBytes }), { allow: true }) }]);
    await runIngestGuards(registry, candidate);
    expect(seen).toEqual({ sha256: candidate.sha256, md5: candidate.md5, size: 3 });
  });

  it("fails closed when a guard throws, rejects, or returns no verdict", async () => {
    const cases: IngestGuard[] = [
      {
        check: () => {
          throw new Error("db down");
        },
      },
      { check: async () => Promise.reject(new Error("db down")) },
      { check: () => undefined as unknown as { allow: true } },
      { check: () => ({ allow: false }) as unknown as { allow: true } },
    ];
    for (const guard of cases) {
      const registry = createIngestGuardRegistry();
      registry.register("broken", [guard]);
      const error = await runIngestGuards(registry, candidate).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IngestCheckFailedError);
      expect(error).toMatchObject({ ownerId: "broken" });
    }
  });

  it("fails closed on a guard that overruns its time, aborting its signal", async () => {
    const registry = createIngestGuardRegistry();
    let aborted = false;
    registry.register("slow", [
      {
        check: ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ allow: true });
            });
          }),
      },
    ]);
    const error = await runIngestGuards(registry, candidate, 20).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestCheckFailedError);
    expect(aborted).toBe(true);
  });
});
