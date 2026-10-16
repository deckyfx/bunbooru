import type { AssetKeyset, AssetOrder } from "@bunbooru/db";

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

/** `createdAt:desc`: what a cursor was minted for. Random order has no cursors. */
function signature(order: Extract<AssetOrder, { kind: "column" }>): string {
  return `${order.key}:${order.direction}`;
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
  order: Extract<AssetOrder, { kind: "column" }>,
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
 * ISO timestamp for `createdAt`, an integer otherwise). The value is validated
 * here because it's bound straight into the keyset comparison.
 */
export function decodeCursor(
  token: string,
  order: Extract<AssetOrder, { kind: "column" }>,
): DecodedCursor | null {
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

  if (order.key === "createdAt") {
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return null;
  } else if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    return null;
  }
  return { keyset: { value: v, id: i }, direction: d === "n" ? "next" : "prev" };
}
