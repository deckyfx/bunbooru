import { describe, expect, it } from "bun:test";
import { SQL, sql } from "drizzle-orm";

import type { KeysetOrder } from "@bunbooru/db";

import { decodeCursor, encodeCursor } from "../src/search/asset-cursor";
import { createSortProviderRegistry } from "../src/search/sort-providers";
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

  it("never finds an inherited property as an order", () => {
    expect(parseOrder("constructor")).toBeNull();
    expect(parseOrder("__proto__")).toBeNull();
  });
});

describe("parseOrder with plugin sort keys", () => {
  /** A registry with `score` (scores plugin); records the asset handle it was bound to. */
  const setup = () => {
    const bound: SQL[] = [];
    const registry = createSortProviderRegistry();
    registry.register("scores", [
      {
        key: "score",
        value: (asset) => {
          bound.push(asset.id);
          return sql`coalesce((select 1), 0)`;
        },
      },
    ]);
    return { registry, bound };
  };
  /** The order minus its SQL (compared separately). */
  const shape = (order: ReturnType<typeof parseOrder>) =>
    order?.kind === "expression" ? { kind: order.kind, key: order.key, direction: order.direction } : order;

  it.each([
    ["score", "desc"],
    ["score_desc", "desc"],
    ["score_asc", "asc"],
    ["SCORE_ASC", "asc"],
  ] as const)("order:%s sorts by the plugin's value, %s", (value, direction) => {
    const { registry, bound } = setup();
    const order = parseOrder(value, registry);
    expect(shape(order)).toEqual({ kind: "expression", key: "score", direction });
    expect(order?.kind === "expression" && order.value instanceof SQL).toBe(true);
    expect(bound).toHaveLength(1); // bound to the asset id once
    expect(bound[0]).toBeInstanceOf(SQL);
  });

  it("returns null for a key no plugin provides", () => {
    const { registry } = setup();
    expect(parseOrder("upvotes", registry)).toBeNull();
    expect(parseOrder("upvotes_asc", registry)).toBeNull();
    expect(parseOrder("_asc", registry)).toBeNull();
  });

  it("returns null once the provider is unregistered", () => {
    const { registry } = setup();
    registry.unregister("scores");
    expect(parseOrder("score", registry)).toBeNull();
  });

  it("lets Core's keys win", () => {
    const { registry, bound } = setup();
    expect(parseOrder("views", registry)).toEqual({ kind: "column", key: "viewCount", direction: "desc" });
    expect(parseOrder("id_desc", registry)).toEqual({ kind: "column", key: "id", direction: "desc" });
    expect(parseOrder("random", registry)).toEqual({ kind: "random" });
    expect(bound).toHaveLength(0);
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

describe("asset cursor for a plugin sort key", () => {
  const score = (direction: "asc" | "desc", key = "score"): KeysetOrder => ({
    kind: "expression",
    key,
    value: sql`0`,
    direction,
  });
  /** A hand-built token, for payloads `encodeCursor` can't produce. */
  const raw = (json: string) => btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("round-trips a position, including a negative or fractional value", () => {
    for (const value of [12, 0, -3, 2.5]) {
      const token = encodeCursor(score("desc"), { value, id: 7 }, "prev");
      expect(decodeCursor(token, score("desc"))).toEqual({ keyset: { value, id: 7 }, direction: "prev" });
    }
  });

  it("is refused under another order: the other direction, a Core order, another key", () => {
    const token = encodeCursor(score("desc"), { value: 3, id: 7 }, "next");
    expect(decodeCursor(token, score("asc"))).toBeNull();
    expect(decodeCursor(token, { kind: "column", key: "viewCount", direction: "desc" })).toBeNull();
    expect(decodeCursor(token, score("desc", "upvotes"))).toBeNull();
    // Nor does a Core cursor pass for a plugin order.
    const views = encodeCursor({ kind: "column", key: "viewCount", direction: "desc" }, { value: 3, id: 7 }, "next");
    expect(decodeCursor(views, score("desc"))).toBeNull();
  });

  it("refuses a value that isn't a finite number", () => {
    expect(decodeCursor(encodeCursor(score("desc"), { value: "3", id: 7 }, "next"), score("desc"))).toBeNull();
    expect(decodeCursor(raw('{"o":"x:score:desc","v":1e400,"i":7,"d":"n"}'), score("desc"))).toBeNull();
    expect(decodeCursor(raw('{"o":"x:score:desc","v":null,"i":7,"d":"n"}'), score("desc"))).toBeNull();
    expect(decodeCursor(raw('{"o":"x:score:desc","v":3,"i":7,"d":"n"}'), score("desc"))).toEqual({
      keyset: { value: 3, id: 7 },
      direction: "next",
    });
  });
});
