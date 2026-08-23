import { describe, expect, it } from "bun:test";

import { buildSequence, planMigrations } from "../src/index";

/** A build sequence A(1) → B(2) → C(3). */
const BUILD = [
  { when: 1, tag: "A", hash: "ha" },
  { when: 2, tag: "B", hash: "hb" },
  { when: 3, tag: "C", hash: "hc" },
];

describe("planMigrations", () => {
  it("returns the full count on a fresh database", () => {
    expect(planMigrations([], BUILD)).toBe(3);
  });

  it("returns 0 when everything is applied", () => {
    const applied = [
      { hash: "ha", when: 1 },
      { hash: "hb", when: 2 },
      { hash: "hc", when: 3 },
    ];
    expect(planMigrations(applied, BUILD)).toBe(0);
  });

  it("counts only migrations past the high-water mark as pending", () => {
    const applied = [{ hash: "ha", when: 1 }]; // A applied → B, C pending
    expect(planMigrations(applied, BUILD)).toBe(2);
  });

  it("tolerates superseded orphan rows at/below the high-water mark", () => {
    // An early, renumbered migration ('old', when 0) that this build no longer
    // carries — harmless history; A/B/C still recognized, nothing pending.
    const applied = [
      { hash: "old", when: 0 },
      { hash: "ha", when: 1 },
      { hash: "hb", when: 2 },
      { hash: "hc", when: 3 },
    ];
    expect(planMigrations(applied, BUILD)).toBe(0);
  });

  it("throws when the database is ahead of this build (downgrade)", () => {
    const applied = [
      { hash: "ha", when: 1 },
      { hash: "hb", when: 2 },
      { hash: "hc", when: 3 },
      { hash: "hd", when: 4 }, // a migration newer than the build knows
    ];
    expect(() => planMigrations(applied, BUILD)).toThrow(/older than the database/);
  });

  it("throws on a gap — a build migration below the mark that isn't applied", () => {
    // DB is at C (when 3) but B (when 2) was never applied → Drizzle would skip B.
    const applied = [
      { hash: "ha", when: 1 },
      { hash: "hc", when: 3 },
    ];
    expect(() => planMigrations(applied, BUILD)).toThrow(/schema gap/);
  });
});

describe("buildSequence", () => {
  const JOURNAL = JSON.stringify({
    entries: [
      { idx: 1, when: 20, tag: "0001_b", breakpoints: true },
      { idx: 0, when: 10, tag: "0000_a", breakpoints: true },
    ],
  });

  it("parses the embedded journal into hashed entries in idx order", () => {
    const seq = buildSequence({ journal: JOURNAL, files: { "0000_a.sql": "A", "0001_b.sql": "B" } });
    expect(seq.map((s) => s.tag)).toEqual(["0000_a", "0001_b"]);
    expect(seq[0]?.when).toBe(10);
    expect(seq[0]?.hash).toMatch(/^[0-9a-f]{64}$/); // sha256 of the raw SQL
  });

  it("throws when a journal tag has no embedded .sql (packaging fault)", () => {
    expect(() => buildSequence({ journal: JOURNAL, files: { "0000_a.sql": "A" } })).toThrow(
      /no 0001_b\.sql was compiled in/,
    );
  });

  it("throws on malformed journal JSON", () => {
    expect(() => buildSequence({ journal: "{ not json", files: {} })).toThrow();
  });
});
