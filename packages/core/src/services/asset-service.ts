import type {
  Asset,
  AssetKeyset,
  AssetPageRow,
  AssetRepository,
  AssetUpdate,
  NewAsset,
} from "@bunbooru/db";
import type { StorageProvider, StoredObject } from "@bunbooru/storage";

import { UnsupportedMediaError, ValidationError } from "../errors";
import type { CoreEvents } from "../events";
import { runIngestGuards, type IngestGuardList } from "../ingest/guards";
import { decodeCursor, encodeCursor } from "../search/asset-cursor";
import { compileAssetSearch, type SearchContext } from "../search/asset-query";

/** Most ids {@link AssetService.getMany} resolves in one call (bounds one query). */
export const MAX_GET_MANY = 500;

/** Default and ceiling page sizes — the ceiling bounds the cost of one query. */
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;
/**
 * Totals are counted no further than this: beyond it the listing reports
 * "10,000+", so the count costs a bounded scan however many posts match.
 */
export const MAX_COUNTED_TOTAL = 10_000;

/** Decompression-bomb guard: reject images whose pixel count exceeds this. */
const MAX_PIXELS = 100_000_000; // ~100 MP

/** Key prefix under which all asset blobs live (see {@link contentKey}). */
const ASSET_KEY_PREFIX = "assets/";

/** Default and hard-ceiling batch size for the orphan-blob sweep (bounds per-batch work). */
const ORPHAN_GC_BATCH = 500;
const MAX_ORPHAN_GC_BATCH = 5_000;

/** Canonical MIME by Bun-sniffed image format — also the accept-list. */
const MIME_BY_FORMAT: Partial<Record<string, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** File extension by sniffed format. */
const EXT_BY_FORMAT: Partial<Record<string, string>> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

/** A keyset page of assets plus what a client needs to move from it. */
export interface AssetListPage {
  assets: Asset[];
  /** Matching assets, counted up to {@link MAX_COUNTED_TOTAL}. */
  total: number;
  /** True when more than {@link MAX_COUNTED_TOTAL} match (`total` is then the cap). */
  totalCapped: boolean;
  /** Page size actually served (after clamping). */
  perPage: number;
  /** Continue toward later results; null on the last page (and for `order:random`). */
  nextCursor: string | null;
  /** Go back toward the first page; null on the first page (and for `order:random`). */
  prevCursor: string | null;
}

/** Optional, possibly out-of-range paging input from the transport layer. */
export interface ListAssetsOptions {
  perPage?: number;
  /** Booru query string (tags + metatags, incl. `order:`); compiled to SQL. */
  query?: string;
  /**
   * An opaque cursor from a previous page's `nextCursor`/`prevCursor`; omit for
   * the first page. Only valid with the same `order:` it was minted under.
   */
  cursor?: string;
}

/** Optional metadata a client may set on ingest — shared by both create paths. */
export interface CreateAssetMeta {
  rating?: Asset["rating"];
  source?: string | null;
  uploaderId?: number | null;
  /**
   * Original creation timestamp to preserve (defaults to now when omitted).
   * Used by migration/import so imported posts keep their source's original
   * "posted" date rather than sorting as freshly uploaded.
   */
  createdAt?: Date;
}

/**
 * The bytes to ingest via {@link AssetService.createFromSource}. A `file` source
 * names a local path the service both hashes and may *move* into storage — the
 * Blob is derived from that path, so the bytes that are hashed/sniffed and the
 * bytes that land in storage can never diverge. A `blob` source is hashed and
 * always copied (no move).
 */
export type IngestSource = { kind: "blob"; blob: Blob } | { kind: "file"; path: string };

/** Raw upload: the in-memory bytes plus optional metadata the client may set. */
export interface CreateAssetInput extends CreateAssetMeta {
  bytes: Uint8Array;
}

/** Upload outcome: the stored (or pre-existing) asset and whether it deduped. */
export interface CreateAssetResult {
  asset: Asset;
  /** True when an identical upload (same sha256) already existed. */
  deduped: boolean;
}

/** An asset's bytes ready to stream back to a client, with its content type. */
export interface AssetFile {
  stream: ReadableStream<Uint8Array>;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Application logic for assets. Holds no SQL — it composes an
 * {@link AssetRepository} and a {@link StorageProvider}, owning the upload
 * pipeline (hash → dedupe → sniff → store → insert) and pagination rules so
 * every transport gets identical behaviour.
 */
export interface AssetService {
  list(options?: ListAssetsOptions): Promise<AssetListPage>;
  /** One asset by id, or null. */
  getById(id: number): Promise<Asset | null>;
  /**
   * The assets for `ids` in ONE query, returned in the order the ids were given
   * (duplicates collapsed, unknown or invalid ids skipped). Lets a plugin that
   * keeps its own ordering (a pool) render it without one lookup per post.
   * Throws `ValidationError` beyond {@link MAX_GET_MANY} ids.
   */
  getMany(ids: readonly number[]): Promise<Asset[]>;
  /** Ingest an in-memory upload: dedupe by content hash, else store + persist. */
  create(input: CreateAssetInput): Promise<CreateAssetResult>;
  /**
   * Ingest an upload whose bytes are a (possibly file-backed) {@link Blob} —
   * streams hash → sniff → store without buffering the whole object into memory.
   * Used by the resumable upload finalize path; {@link create} wraps this for
   * in-memory bytes. Same pipeline, so both paths dedupe/sniff/emit identically.
   * A `file` {@link IngestSource} lets a same-filesystem provider finalize by
   * moving the file into storage instead of copying it.
   */
  createFromSource(source: IngestSource, meta?: CreateAssetMeta): Promise<CreateAssetResult>;
  /**
   * Delete a post for good: its row, tag links and stored file go, and a
   * tombstone keeps its hashes, who deleted it, why and when. Emits
   * `asset.deleted` so plugins drop their rows. False when there's no such
   * post. Re-uploading the same bytes later makes a new post. Authorization
   * is the caller's job.
   */
  delete(id: number, by: { deletedById: number | null; reason: string }): Promise<boolean>;
  /** Patch an asset's mutable metadata (rating/source); null if it doesn't exist. */
  update(id: number, patch: AssetUpdate): Promise<Asset | null>;
  /** Open an asset's stored bytes for streaming, or null if the asset is absent. */
  openFile(id: number): Promise<AssetFile | null>;
  /**
   * The neighbouring post ids in the newest-first browse order — `newerId` (shown
   * just before this post) and `olderId` (just after). Null at the ends. Powers
   * the detail page's prev/next navigation.
   */
  neighbors(id: number): Promise<{ newerId: number | null; olderId: number | null }>;
  /**
   * Reclaim orphaned asset blobs — stored objects no asset row references, left
   * by a rare non-race insert failure after the blob was written (content keys
   * are deduped, so they're benign but waste space). Only objects last modified
   * before `olderThan` are removed, so an in-flight upload's just-written blob
   * (stored, row not yet inserted) is never reclaimed. Returns how many were
   * removed. Runs in bounded batches over the whole store, so call it on a slow
   * cadence (it's an O(stored-objects) scan), not the frequent session sweep.
   */
  gcOrphanedBlobs(olderThan: Date, batchSize?: number): Promise<number>;
}

/** Clamp to an integer ≥ 1, falling back to `fallback` for missing/invalid input. */
function toPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored < 1 ? fallback : floored;
}

/** A listed row as a plain {@link Asset}, without the value it was sorted by. */
function withoutSortValue({ sortValue: _sortValue, ...asset }: AssetPageRow): Asset {
  return asset;
}

/** Content-addressed key, sharded by hash prefix: `assets/<aa>/<bb>/<sha256>.<ext>`. */
function contentKey(sha256: string, ext: string): string {
  return `assets/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`;
}

/** Build an {@link AssetService} over the given repository and storage provider. */
export function createAssetService(
  repository: AssetRepository,
  storage: StorageProvider,
  events?: CoreEvents,
  search: SearchContext = {},
  guards?: IngestGuardList,
): AssetService {
  /**
   * The shared ingest pipeline: hash → guard → dedupe → sniff → store → insert → emit,
   * over a (possibly file-backed) {@link Blob}. The blob is read in independent
   * passes — one streaming hash pass, one lazy sniff, one streaming store — so
   * the whole object never has to be resident in memory. Order is fixed: the
   * content hash names the storage key and drives dedupe, and the sniffed format
   * supplies the key's extension, so hashing precedes the sniff which precedes
   * the store.
   */
  async function ingest(
    source: Blob,
    { rating, source: sourceUrl, uploaderId, createdAt }: CreateAssetMeta = {},
    localPath?: string,
  ): Promise<CreateAssetResult> {
    // Capture the size now: the move fast-path below consumes the source file, so
    // reading `source.size` afterwards (a fresh stat) would see a vanished file.
    const sizeBytes = source.size;

    // One streaming pass computes both content hashes without buffering the blob.
    const shaHasher = new Bun.CryptoHasher("sha256");
    const md5Hasher = new Bun.CryptoHasher("md5");
    for await (const chunk of source.stream()) {
      shaHasher.update(chunk);
      md5Hasher.update(chunk);
    }
    const sha256 = shaHasher.digest("hex");
    const md5 = md5Hasher.digest("hex");

    // Plugin guards (a hash ban, a quota) may refuse the upload. BEFORE dedupe,
    // so a banned file can't be laundered through a copy already stored; and
    // before any decode, so a refusal costs only the hash pass.
    if (guards) {
      await runIngestGuards(guards, {
        sha256,
        md5,
        sizeBytes,
        uploaderId: uploaderId ?? null,
        source: sourceUrl ?? null,
        blob: source,
      });
    }

    // Dedupe on the content hash before the heavier decode/store work.
    const existing = await repository.findBySha256(sha256);
    if (existing) return { asset: existing, deduped: true };

    // Sniff dimensions + true format from the bytes — never trust a client MIME.
    // Bun.Image reads the blob lazily; `maxPixels` rejects decompression bombs
    // before allocating the pixel buffer.
    const meta = await new Bun.Image(source, { maxPixels: MAX_PIXELS })
      .metadata()
      .catch(() => null);
    if (!meta) throw new UnsupportedMediaError();
    const mimeType = MIME_BY_FORMAT[meta.format];
    const ext = EXT_BY_FORMAT[meta.format];
    if (!mimeType || !ext) {
      throw new UnsupportedMediaError(`Unsupported image format: ${meta.format}`);
    }

    const storageKey = contentKey(sha256, ext);
    // Persist the bytes. When the caller hands us the source's local path AND the
    // provider can ingest a local file (same-filesystem), MOVE it into place —
    // no copy. Otherwise stream the blob in. The move consumes the source, so a
    // (rare) insert failure below can't fall back to the staged file for retry;
    // the moved-but-unreferenced blob is reclaimed by orphan-blob GC.
    if (localPath !== undefined && storage.ingestLocalFile) {
      await storage.ingestLocalFile(localPath, storageKey);
    } else {
      // Hand the blob (not a stream) to storage: a file-backed `Bun.file()` is
      // written natively without buffering the whole object.
      await storage.store(storageKey, source);
    }

    const input: NewAsset = {
      storageKey,
      mimeType,
      width: meta.width,
      height: meta.height,
      sizeBytes,
      sha256,
      md5,
      source: sourceUrl ?? null,
      uploaderId: uploaderId ?? null,
      ...(rating ? { rating } : {}),
      // Preserve an original post date when provided (migration/import); the
      // column otherwise defaults to now.
      ...(createdAt ? { createdAt } : {}),
    };

    let asset: Asset;
    try {
      asset = await repository.create(input);
    } catch (error) {
      // Lost a dedupe race (another request inserted this sha256 first). The
      // content is identical, so `storageKey` is the SAME object the winner
      // references — must NOT delete it. Just reuse the winner.
      const raced = await repository.findBySha256(sha256);
      if (raced) return { asset: raced, deduped: true };
      // A non-race insert failure leaves `storageKey` written but unreferenced.
      // We deliberately do NOT delete it here: the key is content-addressed, so a
      // concurrent upload of the same bytes may have written/own the same object
      // and be about to insert its row — deleting would orphan that row (a row
      // pointing at missing bytes, worse than a spare blob). Orphaned blobs are
      // benign (space only; a later identical upload dedupes onto them) and are
      // reclaimed by a separate reference-counted orphan-GC pass (follow-up).
      throw error;
    }

    // Announce the new asset so plugins (auto-tag, similar-finder, thumbnails,
    // …) can react. Kept OUTSIDE the race `try` so a (hypothetical) emit throw
    // can't be misread as a dedupe hit. Fire-and-forget + error-isolated in the
    // bus, so a listener can never fail or delay the upload. Not on a dedupe.
    events?.emit("asset.created", {
      id: asset.id,
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      sizeBytes: asset.sizeBytes,
      rating: asset.rating,
      source: asset.source,
      createdAt: asset.createdAt,
    });
    return { asset, deduped: false };
  }

  /**
   * Best-effort removal of a deleted post's stored file. Keys are
   * content-addressed, so if the same bytes were re-uploaded between the row's
   * deletion and now, the new post owns this very object: it is kept. A failed
   * delete is swallowed on purpose: the row is already gone, and the orphan is
   * reclaimed by {@link AssetService.gcOrphanedBlobs}. (A re-upload landing
   * exactly between the check and the delete can still lose its blob, the same
   * accepted window as the orphan GC: `openFile` then 404s, never serves wrong
   * bytes.)
   */
  async function removeBlob(storageKey: string): Promise<void> {
    try {
      const referenced = await repository.findReferencedStorageKeys([storageKey]);
      if (referenced.has(storageKey)) return;
      await storage.delete(storageKey);
    } catch {
      // Left for the orphan-blob GC (see above).
    }
  }

  return {
    async list(options = {}) {
      const perPage = Math.min(toPositiveInt(options.perPage, DEFAULT_PER_PAGE), MAX_PER_PAGE);
      // Trim first so surrounding whitespace is normalized away, not fed to the parser.
      const query = options.query?.trim() ?? "";
      const { where, order } = await compileAssetSearch(query, search);

      // Validate the cursor before any database work: a refused cursor costs no
      // queries. (Random order has no cursors, so one is simply ignored there.)
      // A cursor minted under another order (including a plugin sort key whose
      // plugin has since been deactivated, which falls back to the default
      // order) doesn't match, and is refused the same way.
      const decoded =
        options.cursor && order.kind !== "random" ? decodeCursor(options.cursor, order) : null;
      if (options.cursor && order.kind !== "random" && !decoded) {
        throw new ValidationError("Invalid or expired page cursor");
      }

      // The count runs alongside the page; capped, so it's bounded either way.
      const countPromise = repository.countUpTo(where, MAX_COUNTED_TOTAL);
      // If the page query throws first, nothing awaits this promise, and a
      // rejection nobody observes would take the process down (as it can when
      // a database outage fails both queries). Mark it handled here; `totals()`
      // still awaits it and rethrows on the success path.
      countPromise.catch(() => {});
      const totals = async () => {
        const counted = await countPromise;
        return {
          total: Math.min(counted, MAX_COUNTED_TOTAL),
          totalCapped: counted > MAX_COUNTED_TOTAL,
        };
      };

      if (order.kind === "random") {
        const rows = await repository.findPage({ where, order, limit: perPage });
        return { assets: rows, ...(await totals()), perPage, nextCursor: null, prevCursor: null };
      }

      const keysetOf = (row: AssetPageRow): AssetKeyset => {
        if (order.kind === "expression") {
          // The repository returns the value each row was sorted by.
          if (row.sortValue === undefined) throw new Error("expression-ordered row has no sort value");
          return { value: row.sortValue, id: row.id };
        }
        return {
          value: order.key === "createdAt" ? row.createdAt.toISOString() : row[order.key],
          id: row.id,
        };
      };
      const cursorAt = (row: AssetPageRow, direction: "next" | "prev") =>
        encodeCursor(order, keysetOf(row), direction);

      // Ask for one row more than a page: its presence is how we know another
      // page exists that way, without a count.
      const forward = async (after?: AssetKeyset) => {
        const rows = await repository.findPage({ where, order, limit: perPage + 1, after });
        const hasMore = rows.length > perPage;
        const page = hasMore ? rows.slice(0, perPage) : rows;
        const last = page.at(-1);
        const first = page[0];
        return {
          assets: page,
          nextCursor: hasMore && last ? cursorAt(last, "next") : null,
          prevCursor: after && first ? cursorAt(first, "prev") : null,
        };
      };

      let page: Pick<AssetListPage, "assets" | "nextCursor" | "prevCursor">;
      if (!decoded) {
        page = await forward();
      } else {
        if (decoded.direction === "next") {
          page = await forward(decoded.keyset);
        } else {
          const rows = await repository.findPage({
            where,
            order,
            limit: perPage + 1,
            after: decoded.keyset,
            backward: true,
          });
          if (rows.length <= perPage) {
            // Walked back to the start: serve the real first page, so it's
            // always a full page rather than whatever was left over.
            page = await forward();
          } else {
            const kept = rows.slice(0, perPage).reverse();
            page = {
              assets: kept,
              nextCursor: cursorAt(kept.at(-1)!, "next"),
              prevCursor: cursorAt(kept[0]!, "prev"),
            };
          }
        }
      }
      // The sort value only served the cursors; callers get plain assets.
      const listed = order.kind === "expression" ? page.assets.map(withoutSortValue) : page.assets;
      return { ...page, assets: listed, ...(await totals()), perPage };
    },

    getById(id) {
      return repository.findById(id);
    },

    async getMany(ids) {
      const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
      if (wanted.length > MAX_GET_MANY) {
        throw new ValidationError(`At most ${MAX_GET_MANY} assets can be fetched at once`);
      }
      const byId = new Map((await repository.findByIds(wanted)).map((asset) => [asset.id, asset]));
      return wanted.map((id) => byId.get(id)).filter((asset): asset is Asset => asset !== undefined);
    },

    create({ bytes, rating, source, uploaderId }) {
      // Snapshot the mutable buffer into an immutable, re-readable Blob so a
      // caller mutating `bytes` mid-flight can't desync the hashes, sniff, and
      // stored bytes. Copy into a fresh (ArrayBuffer-backed) view first — the
      // input may be SharedArrayBuffer-backed, which isn't a valid BlobPart.
      // Then go through the same streaming pipeline as a file-backed upload.
      return ingest(new Blob([new Uint8Array(bytes)]), { rating, source, uploaderId });
    },

    createFromSource(source, meta = {}) {
      // For a file source, derive the Blob from the SAME path we may move into
      // storage, so the hashed/sniffed bytes and the stored bytes can't diverge.
      return source.kind === "file"
        ? ingest(Bun.file(source.path), meta, source.path)
        : ingest(source.blob, meta);
    },

    async delete(id, { deletedById, reason }) {
      const deletedAt = new Date();
      // Row, tag links and tombstone go together in one transaction.
      const deleted = await repository.deleteWithTombstone(id, { deletedById, reason, now: deletedAt });
      if (!deleted) return false;
      await removeBlob(deleted.storageKey);
      // Fire-and-forget like `asset.created`: plugins drop their own rows
      // (thumbnails, favorites, pool entries); a failing listener can't undo
      // or delay the deletion.
      events?.emit("asset.deleted", {
        id: deleted.id,
        sha256: deleted.sha256,
        md5: deleted.md5,
        deletedById,
        reason,
        deletedAt,
      });
      return true;
    },

    update(id, patch) {
      return repository.update(id, patch);
    },

    neighbors(id) {
      return repository.neighbors(id);
    },

    async openFile(id) {
      const asset = await repository.findById(id);
      if (!asset) return null;
      // A row can outlive its blob (manual deletion, failed write). Treat a
      // missing object as "not found" (null → 404) rather than letting the
      // provider throw and surface as a 500.
      if (!(await storage.exists(asset.storageKey))) return null;
      const stream = await storage.stream(asset.storageKey);
      return { stream, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
    },

    async gcOrphanedBlobs(olderThan, batchSize = ORPHAN_GC_BATCH) {
      // Normalize the bound so a NaN/Infinity/0 — or an absurdly large finite
      // value — can't turn this into one giant unbounded batch (and IN query),
      // defeating the bounded-work contract.
      const requested =
        Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : ORPHAN_GC_BATCH;
      const limit = Math.min(requested, MAX_ORPHAN_GC_BATCH);
      let removed = 0;
      let batch: StoredObject[] = [];
      // Resolve a batch: one query tells us which keys are still referenced; the
      // rest, if old enough to clear the grace window, are deletion candidates.
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const referenced = await repository.findReferencedStorageKeys(batch.map((o) => o.key));
        const candidates = batch.filter((o) => !referenced.has(o.key) && o.modifiedAt < olderThan);
        const deleted = await Promise.all(
          candidates.map(async (o) => {
            // Re-confirm age immediately before deleting: between enumeration and
            // now the key may have been rewritten (a re-upload of identical
            // content bumps mtime, with a row insert imminent). Skip anything no
            // longer old, or already gone — narrows the race to this stat→delete
            // gap. Only count deletes that actually succeed.
            //
            // A microsecond window remains (a rewrite landing between this stat
            // and the delete) that a filesystem can't close atomically. It's
            // accepted: keys are content-addressed, so the worst case is a row
            // pointing at a now-missing-but-identical blob (openFile → 404, never
            // wrong bytes), and it requires an old orphan being re-uploaded with
            // byte-exact timing. Fully closing it needs cross-process coordination
            // (provider conditional-delete or a DB key reservation) — a future
            // step if it ever bites.
            const current = await storage.statModifiedAt(o.key);
            if (current === null || current >= olderThan) return false;
            try {
              await storage.delete(o.key);
              return true;
            } catch {
              return false;
            }
          }),
        );
        removed += deleted.filter(Boolean).length;
        batch = [];
      };
      for await (const object of storage.list(ASSET_KEY_PREFIX)) {
        batch.push(object);
        if (batch.length >= limit) await flush();
      }
      await flush();
      return removed;
    },
  };
}
