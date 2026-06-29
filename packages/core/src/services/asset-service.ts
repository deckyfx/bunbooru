import type { Asset, AssetRepository, NewAsset } from "@bunbooru/db";
import type { StorageProvider } from "@bunbooru/storage";

import { UnsupportedMediaError } from "../errors";

/** Default and ceiling page sizes — the ceiling bounds the cost of one query. */
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

/** Decompression-bomb guard: reject images whose pixel count exceeds this. */
const MAX_PIXELS = 100_000_000; // ~100 MP

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
}

/** Raw upload: the bytes plus optional metadata the client may set. */
export interface CreateAssetInput {
  bytes: Uint8Array;
  rating?: Asset["rating"];
  source?: string | null;
  uploaderId?: number | null;
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
  /** Ingest an upload: dedupe by content hash, else store + persist. */
  create(input: CreateAssetInput): Promise<CreateAssetResult>;
  /** Open an asset's stored bytes for streaming, or null if the asset is absent. */
  openFile(id: number): Promise<AssetFile | null>;
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
): AssetService {
  return {
    async list(options = {}) {
      const perPage = Math.min(toPositiveInt(options.perPage, DEFAULT_PER_PAGE), MAX_PER_PAGE);
      // Cap page so (page - 1) * perPage can't exceed MAX_SAFE_INTEGER and turn
      // the offset into a rounded/Infinity value — protects non-HTTP callers too.
      const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / perPage) + 1;
      const page = Math.min(toPositiveInt(options.page, 1), maxPage);
      const offset = (page - 1) * perPage;

      // Count and page in parallel — they're independent reads.
      const [list, total] = await Promise.all([
        repository.findMany({ limit: perPage, offset }),
        repository.count(),
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

    async create({ bytes, rating, source, uploaderId }) {
      // Snapshot first: a Uint8Array is mutable and we await below, so a caller
      // mutating the buffer mid-flight must not desync the stored bytes, hashes,
      // and sniffed metadata. Bun.Image also borrows the bytes off-thread.
      const data = new Uint8Array(bytes);

      // Dedupe on the content hash before any heavier work (decode, store).
      const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
      const existing = await repository.findBySha256(sha256);
      if (existing) return { asset: existing, deduped: true };

      // Sniff dimensions + true format from the bytes — never trust a client MIME.
      // `maxPixels` rejects decompression bombs before allocating the pixel buffer.
      const meta = await new Bun.Image(data, { maxPixels: MAX_PIXELS })
        .metadata()
        .catch(() => null);
      if (!meta) throw new UnsupportedMediaError();
      const mimeType = MIME_BY_FORMAT[meta.format];
      const ext = EXT_BY_FORMAT[meta.format];
      if (!mimeType || !ext) {
        throw new UnsupportedMediaError(`Unsupported image format: ${meta.format}`);
      }

      const md5 = new Bun.CryptoHasher("md5").update(data).digest("hex");
      const storageKey = contentKey(sha256, ext);
      await storage.store(storageKey, data);

      const input: NewAsset = {
        storageKey,
        mimeType,
        width: meta.width,
        height: meta.height,
        sizeBytes: data.byteLength,
        sha256,
        md5,
        source: source ?? null,
        uploaderId: uploaderId ?? null,
        ...(rating ? { rating } : {}),
      };

      try {
        const asset = await repository.create(input);
        return { asset, deduped: false };
      } catch (error) {
        // Lost a dedupe race (another request inserted this sha256 first). The
        // content is identical, so `storageKey` is the SAME object the winner
        // references — must NOT delete it. Just reuse the winner.
        const raced = await repository.findBySha256(sha256);
        if (raced) return { asset: raced, deduped: true };
        throw error;
      }
    },

    async openFile(id) {
      const asset = await repository.findById(id);
      if (!asset) return null;
      const stream = await storage.stream(asset.storageKey);
      return { stream, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
    },
  };
}
