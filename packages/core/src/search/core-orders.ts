import type { AssetOrder } from "@bunbooru/db";

/**
 * The `order:` vocabulary. A bare key sorts the way a booru user expects
 * (`id` oldest first, everything else biggest/newest first); `_asc` / `_desc`
 * pick the other way. The default browse order is `id_desc`.
 */
export const CORE_ORDERS: Readonly<Record<string, AssetOrder>> = {
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

/**
 * Core's own order keys, without their `_asc` / `_desc` forms (`id`, `date`,
 * `views`, …). A plugin sort key may not claim any of them.
 */
export const CORE_ORDER_KEYS: ReadonlySet<string> = new Set(
  Object.keys(CORE_ORDERS).map((key) => key.replace(/_(asc|desc)$/, "")),
);
