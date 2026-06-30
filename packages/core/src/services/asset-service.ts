import type { Asset, AssetRepository, AssetUpdate, NewAsset } from "@bunbooru/db";
import type { StorageProvider, StoredObject } from "@bunbooru/storage";

import { UnsupportedMediaError } from "../errors";
import type { CoreEvents } from "../events";
import { compileAssetSearch } from "../search/asset-query";

/** Default and ceiling page sizes — the ceiling bounds the cost of one query. */
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

/** Decompression-bomb guard: reject images whose pixel count exceeds this. */
const MAX_PIXELS = 100_000_000; // ~100 MP

/** Key prefix under which all asset blobs live (see {@link contentKey}). */
const ASSET_KEY_PREFIX = "assets/";

/** Default batch size for the orphan-blob sweep (bounds per-batch work). */
const ORPHAN_GC_BATCH = 500;

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

/** A page of assets plus the metadata a client needs to render pagination. */
export interface AssetListPage {
  assets: Asset[];
  /** Total assets across all pages. */
  total: number;
  /** 1-based page number actually served (after clamping). */
  page: number;
  /** Page size actually served (after clamping). */
  perPage: number;
  /** Total number of pages for `total` at `perPage` (0 when empty). */
  pageCount: number;
}

/** Optional, possibly out-of-range paging input from the transport layer. */
export interface ListAssetsOptions {
  page?: number;
  perPage?: number;
  /** Booru query string (tags + metatags); compiled to a SQL filter. */
  query?: string;
}

/** Optional metadata a client may set on ingest — shared by both create paths. */
export interface CreateAssetMeta {
  rating?: Asset["rating"];
  source?: string | null;
  uploaderId?: number | null;
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
  /** Patch an asset's mutable metadata (rating/source); null if it doesn't exist. */
  update(id: number, patch: AssetUpdate): Promise<Asset | null>;
  /** Open an asset's stored bytes for streaming, or null if the asset is absent. */
  openFile(id: number): Promise<AssetFile | null>;
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

/** Content-addressed key, sharded by hash prefix: `assets/<aa>/<bb>/<sha256>.<ext>`. */
function contentKey(sha256: string, ext: string): string {
  return `assets/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`;
}

/** Build an {@link AssetService} over the given repository and storage provider. */
export function createAssetService(
  repository: AssetRepository,
  storage: StorageProvider,
  events?: CoreEvents,
): AssetService {
  /**
   * The shared ingest pipeline: hash → dedupe → sniff → store → insert → emit,
   * over a (possibly file-backed) {@link Blob}. The blob is read in independent
   * passes — one streaming hash pass, one lazy sniff, one streaming store — so
   * the whole object never has to be resident in memory. Order is fixed: the
   * content hash names the storage key and drives dedupe, and the sniffed format
   * supplies the key's extension, so hashing precedes the sniff which precedes
   * the store.
   */
  async function ingest(
    source: Blob,
    { rating, source: sourceUrl, uploaderId }: CreateAssetMeta = {},
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

    const md5 = md5Hasher.digest("hex");
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

  return {
    async list(options = {}) {
      const perPage = Math.min(toPositiveInt(options.perPage, DEFAULT_PER_PAGE), MAX_PER_PAGE);
      // Cap page so (page - 1) * perPage can't exceed MAX_SAFE_INTEGER and turn
      // the offset into a rounded/Infinity value — protects non-HTTP callers too.
      const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / perPage) + 1;
      const page = Math.min(toPositiveInt(options.page, 1), maxPage);
      const offset = (page - 1) * perPage;

      // Compile the query string to a SQL filter once; the count must use the
      // same filter so pagination metadata matches the page. Trim first so
      // surrounding whitespace is normalized away, not fed to the parser.
      const query = options.query?.trim();
      const where = query ? compileAssetSearch(query) : undefined;

      // Count and page in parallel — they're independent reads.
      const [list, total] = await Promise.all([
        repository.findMany({ limit: perPage, offset, where }),
        repository.count(where),
      ]);

      return {
        assets: list,
        total,
        page,
        perPage,
        pageCount: Math.ceil(total / perPage),
      };
    },

    getById(id) {
      return repository.findById(id);
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

    update(id, patch) {
      return repository.update(id, patch);
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
      // Normalize the bound so a NaN/Infinity/0 can't turn this into one giant
      // unbounded batch, defeating the bounded-work contract.
      const limit =
        Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : ORPHAN_GC_BATCH;
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
