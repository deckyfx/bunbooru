import type { AssetKeyset, KeysetOrder } from "@bunbooru/db";

/** Which way a cursor continues: toward older/later results, or back toward the start. */
export type CursorDirection = "next" | "prev";

/** A decoded cursor: where to continue from, and which way. */
export interface DecodedCursor {
  keyset: AssetKeyset;
  direction: CursorDirection;
}

/** The wire payload: order signature, keyset value + id, direction. Kept terse; it rides in URLs. */
interface Payload {
  o: string;
  v: number | string;
  i: number;
  d: "n" | "p";
}

/**
 * What a cursor was minted for: `createdAt:desc` for a column, `x:score:desc`
 * for a plugin sort key (prefixed, so a plugin key can never pass for a
 * column's). Random order has no cursors.
 */
function signature(order: KeysetOrder): string {
  return order.kind === "column"
    ? `${order.key}:${order.direction}`
    : `x:${order.key}:${order.direction}`;
}

const toBase64Url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(token: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    return atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

/**
 * An opaque, URL-safe token for "continue from this row". It carries the order
 * it was minted for, so it can't be replayed against a different sort.
 */
export function encodeCursor(
  order: KeysetOrder,
  keyset: AssetKeyset,
  direction: CursorDirection,
): string {
  const payload: Payload = {
    o: signature(order),
    v: keyset.value,
    i: keyset.id,
    d: direction === "next" ? "n" : "p",
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode `token` for use with `order`, or null if it's malformed, minted for a
 * different order, or carries a value of the wrong type for the sort key (an
 * ISO timestamp for `createdAt`, any finite number for a plugin sort key, an
 * integer otherwise). The value is validated here because it's bound straight
 * into the keyset comparison.
 */
export function decodeCursor(token: string, order: KeysetOrder): DecodedCursor | null {
  const json = fromBase64Url(token);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { o, v, i, d } = raw as Record<string, unknown>;
  if (o !== signature(order)) return null;
  if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 1) return null;
  if (d !== "n" && d !== "p") return null;

  let value: number | string;
  if (order.kind === "expression") {
    // A plugin's value needn't be an integer, but it must be a real number.
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    value = v;
  } else if (order.key === "createdAt") {
    if (typeof v !== "string") return null;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) return null;
    // Canonicalize: Date.parse also accepts forms like "Tue Oct 15 2026" that
    // Postgres' timestamptz input rejects, which would turn a bad cursor into a
    // 500 instead of a 400. Every accepted value is now a real ISO timestamp.
    value = new Date(ms).toISOString();
  } else if (typeof v === "number" && Number.isSafeInteger(v)) {
    value = v;
  } else {
    return null;
  }
  return { keyset: { value, id: i }, direction: d === "n" ? "next" : "prev" };
}
