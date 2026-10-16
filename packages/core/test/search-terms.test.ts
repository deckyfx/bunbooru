import { describe, expect, it } from "bun:test";

import { decodeCursor, encodeCursor } from "../src/search/asset-cursor";
import { dateRange, parseOrder } from "../src/search/terms";

describe("parseOrder", () => {
  it.each([
    ["id", { kind: "column", key: "id", direction: "asc" }],
    ["id_desc", { kind: "column", key: "id", direction: "desc" }],
    ["date", { kind: "column", key: "createdAt", direction: "desc" }],
    ["date_asc", { kind: "column", key: "createdAt", direction: "asc" }],
    ["views", { kind: "column", key: "viewCount", direction: "desc" }],
    ["views_asc", { kind: "column", key: "viewCount", direction: "asc" }],
    ["size", { kind: "column", key: "sizeBytes", direction: "desc" }],
    ["size_asc", { kind: "column", key: "sizeBytes", direction: "asc" }],
    ["tagcount", { kind: "column", key: "tagCount", direction: "desc" }],
    ["tagcount_asc", { kind: "column", key: "tagCount", direction: "asc" }],
    ["random", { kind: "random" }],
    ["RANDOM", { kind: "random" }],
  ] as const)("order:%s", (value, expected) => {
    expect(parseOrder(value)).toEqual(expected);
  });

  it("returns null for an unknown order", () => {
    expect(parseOrder("score")).toBeNull();
    expect(parseOrder("")).toBeNull();
  });
});

describe("dateRange (UTC days)", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it("eq covers the whole day", () => {
    expect(dateRange("eq", "2026-10-15")).toEqual({ from: d("2026-10-15"), until: d("2026-10-16") });
  });

  it("maps comparisons to day boundaries", () => {
    expect(dateRange("gt", "2026-10-15")).toEqual({ from: d("2026-10-16") });
    expect(dateRange("gte", "2026-10-15")).toEqual({ from: d("2026-10-15") });
    expect(dateRange("lt", "2026-10-15")).toEqual({ until: d("2026-10-15") });
    expect(dateRange("lte", "2026-10-15")).toEqual({ until: d("2026-10-16") });
  });

  it("a range includes both end days; either end may be open", () => {
    expect(dateRange("range", "2026-01-01..2026-01-31")).toEqual({
      from: d("2026-01-01"),
      until: d("2026-02-01"),
    });
    expect(dateRange("range", "2026-01-01..")).toEqual({ from: d("2026-01-01") });
    expect(dateRange("range", "..2026-01-31")).toEqual({ until: d("2026-02-01") });
  });

  it("rejects malformed and impossible dates", () => {
    expect(dateRange("eq", "2026-13-01")).toBeNull();
    expect(dateRange("eq", "2026-02-30")).toBeNull();
    expect(dateRange("eq", "yesterday")).toBeNull();
    expect(dateRange("eq", "2026-1-5")).toBeNull();
    expect(dateRange("range", "..")).toBeNull();
    expect(dateRange("range", "2026-01-01..nope")).toBeNull();
  });
});

describe("asset cursor", () => {
  const order = { kind: "column", key: "createdAt", direction: "desc" } as const;

  it("round-trips a position and its direction", () => {
    const token = encodeCursor(order, { value: "2026-10-15T01:02:03.000Z", id: 42 }, "next");
    expect(decodeCursor(token, order)).toEqual({
      keyset: { value: "2026-10-15T01:02:03.000Z", id: 42 },
      direction: "next",
    });
  });

  it("is URL-safe", () => {
    const token = encodeCursor(order, { value: "2026-10-15T01:02:03.000Z", id: 42 }, "prev");
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("canonicalizes a non-ISO date the JS parser accepts but Postgres wouldn't", () => {
    const token = encodeCursor(order, { value: "Tue Oct 15 2026 00:00:00 GMT+0000", id: 3 }, "next");
    expect(decodeCursor(token, order)?.keyset.value).toBe("2026-10-15T00:00:00.000Z");
  });

  it("refuses a cursor minted for a different order", () => {
    const token = encodeCursor({ kind: "column", key: "id", direction: "desc" }, { value: 9, id: 9 }, "next");
    expect(decodeCursor(token, order)).toBeNull();
  });

  it("refuses garbage, a wrong value type, and a bad id", () => {
    const numeric = { kind: "column", key: "sizeBytes", direction: "desc" } as const;
    expect(decodeCursor("not-a-cursor", order)).toBeNull();
    expect(decodeCursor("", order)).toBeNull();
    // createdAt needs an ISO timestamp; sizeBytes needs an integer.
    expect(decodeCursor(encodeCursor(order, { value: 5, id: 1 }, "next"), order)).toBeNull();
    expect(decodeCursor(encodeCursor(numeric, { value: "5", id: 1 }, "next"), numeric)).toBeNull();
    expect(decodeCursor(encodeCursor(numeric, { value: 5, id: 0 }, "next"), numeric)).toBeNull();
    expect(decodeCursor(encodeCursor(numeric, { value: 1.5, id: 2 }, "next"), numeric)).toBeNull();
  });
});
