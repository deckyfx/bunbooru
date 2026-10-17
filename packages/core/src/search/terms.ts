import { sql } from "drizzle-orm";

import { assets, type AssetOrder } from "@bunbooru/db";
import type { CompareOp } from "@bunbooru/search";

import { CORE_ORDER_KEYS, CORE_ORDERS } from "./core-orders";
import type { SortProviderLookup } from "./sort-providers";

/** The order a listing uses when the query names none: newest first. */
export const DEFAULT_ORDER: AssetOrder = { kind: "column", key: "id", direction: "desc" };

/**
 * The `order:` value's sort, or null when it isn't one we know. Core's keys
 * win; anything else is looked up in `sortProviders` (the live plugin sort
 * keys) as `<key>` or `<key>_desc` (biggest first, the default, like `views`)
 * or `<key>_asc`. The plugin's expression is bound to `assets.id` here.
 */
export function parseOrder(value: string, sortProviders?: SortProviderLookup): AssetOrder | null {
  const normalized = value.toLowerCase();
  // Own keys only: `order:constructor` must not find Object.prototype's.
  const order = Object.hasOwn(CORE_ORDERS, normalized) ? CORE_ORDERS[normalized] : undefined;
  if (order) return { ...order };
  if (!sortProviders) return null;

  const suffix = /_(asc|desc)$/.exec(normalized);
  const key = suffix ? normalized.slice(0, suffix.index) : normalized;
  // Core keys are never plugin keys (the registry refuses them), so `id_asc`
  // and the like can't reach a provider; checked here too for clarity.
  if (CORE_ORDER_KEYS.has(key)) return null;
  const provider = sortProviders.get(key);
  if (!provider) return null;
  return {
    kind: "expression",
    key,
    value: provider.value({ id: sql`${assets.id}` }),
    direction: suffix?.[1] === "asc" ? "asc" : "desc",
  };
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
