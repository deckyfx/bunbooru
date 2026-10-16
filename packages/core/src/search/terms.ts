import type { AssetOrder } from "@bunbooru/db";
import type { CompareOp } from "@bunbooru/search";

/**
 * The `order:` vocabulary. A bare key sorts the way a booru user expects
 * (`id` oldest first, everything else biggest/newest first); `_asc` / `_desc`
 * pick the other way. The default browse order is `id_desc`.
 */
const ORDERS: Record<string, AssetOrder> = {
  id: { kind: "column", key: "id", direction: "asc" },
  id_desc: { kind: "column", key: "id", direction: "desc" },
  date: { kind: "column", key: "createdAt", direction: "desc" },
  date_asc: { kind: "column", key: "createdAt", direction: "asc" },
  views: { kind: "column", key: "viewCount", direction: "desc" },
  views_asc: { kind: "column", key: "viewCount", direction: "asc" },
  size: { kind: "column", key: "sizeBytes", direction: "desc" },
  size_asc: { kind: "column", key: "sizeBytes", direction: "asc" },
  tagcount: { kind: "column", key: "tagCount", direction: "desc" },
  tagcount_asc: { kind: "column", key: "tagCount", direction: "asc" },
  random: { kind: "random" },
};

/** The order a listing uses when the query names none: newest first. */
export const DEFAULT_ORDER: AssetOrder = { kind: "column", key: "id", direction: "desc" };

/** The `order:` value's sort, or null when it isn't one we know. */
export function parseOrder(value: string): AssetOrder | null {
  const order = ORDERS[value.toLowerCase()];
  return order ? { ...order } : null;
}

/** Half-open UTC interval `[from, until)`; a missing side is unbounded. */
export interface DateRange {
  from?: Date;
  until?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` → that UTC day's midnight, or null if it isn't a real date. */
function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 2026-02-30 over to March; a real date round-trips exactly.
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date
    : null;
}

const nextDay = (day: Date) => new Date(day.getTime() + DAY_MS);

/**
 * A `date:` term as the interval of upload times it selects, by whole UTC days:
 * `date:2026-10-15` is that day, `date:>2026-10-15` starts the day after,
 * `date:2026-01-01..2026-01-31` includes both end days. Null when malformed.
 */
export function dateRange(op: CompareOp, value: string): DateRange | null {
  if (op === "range") {
    const parts = value.split("..");
    if (parts.length !== 2) return null;
    const [lo, hi] = parts as [string, string];
    if (!lo && !hi) return null;
    const from = lo ? parseDay(lo) : undefined;
    const last = hi ? parseDay(hi) : undefined;
    if (from === null || last === null) return null;
    return { ...(from ? { from } : {}), ...(last ? { until: nextDay(last) } : {}) };
  }
  const day = parseDay(value);
  if (!day) return null;
  switch (op) {
    case "eq":
      return { from: day, until: nextDay(day) };
    case "gt":
      return { from: nextDay(day) };
    case "gte":
      return { from: day };
    case "lt":
      return { until: day };
    case "lte":
      return { until: nextDay(day) };
  }
}
