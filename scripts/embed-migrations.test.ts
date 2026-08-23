import { describe, expect, it } from "bun:test";

import { importName, resolveMigrationEntries, type JournalEntry } from "./embed-migrations";

const entry = (idx: number, tag: string, when = idx): JournalEntry => ({
  idx,
  when,
  tag,
  breakpoints: true,
});

describe("resolveMigrationEntries", () => {
  it("returns entries in idx order when journal and files agree", () => {
    const entries = resolveMigrationEntries(
      [entry(1, "0001_b"), entry(0, "0000_a")],
      ["0000_a.sql", "0001_b.sql"],
    );
    expect(entries.map((e) => e.tag)).toEqual(["0000_a", "0001_b"]);
  });

  it("throws on an empty journal", () => {
    expect(() => resolveMigrationEntries([], [])).toThrow(/no migrations/);
  });

  it("throws when a journal tag has no .sql on disk", () => {
    expect(() => resolveMigrationEntries([entry(0, "0000_a")], [])).toThrow(/missing on disk/);
  });

  it("throws on an orphan .sql not listed in the journal", () => {
    expect(() =>
      resolveMigrationEntries([entry(0, "0000_a")], ["0000_a.sql", "0001_orphan.sql"]),
    ).toThrow(/not listed in the journal/);
  });

  it("throws on a duplicate journal tag", () => {
    expect(() =>
      resolveMigrationEntries([entry(0, "0000_a"), entry(1, "0000_a")], ["0000_a.sql"]),
    ).toThrow(/duplicate journal tag/);
  });

  it("throws when two distinct tags collide on the same import binding", () => {
    // "0000-a" and "0000_a" both normalize to `m_0000_a`.
    expect(() =>
      resolveMigrationEntries(
        [entry(0, "0000-a"), entry(1, "0000_a")],
        ["0000-a.sql", "0000_a.sql"],
      ),
    ).toThrow(/collide on import binding/);
  });
});

describe("importName", () => {
  it("normalizes non-alphanumerics to underscores", () => {
    expect(importName("0000_wandering-bushwacker")).toBe("m_0000_wandering_bushwacker");
  });
});
