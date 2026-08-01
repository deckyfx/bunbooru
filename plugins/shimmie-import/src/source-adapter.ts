/** Rating normalized to bunbooru's enum. */
export type SourceRating = "safe" | "questionable" | "explicit" | "unrated";

/** One source post's metadata, normalized across source types. */
export interface SourcePost {
  /** The source's own post id (sequential in shimmie). */
  sourcePostId: number;
  md5: string;
  ext: string;
  mimeType: string | null;
  width: number;
  height: number;
  tags: string[];
  /** Original external source URL recorded on the source post, if any. */
  source: string | null;
  rating: SourceRating;
  /** Original "posted" timestamp to preserve as the asset's createdAt. */
  postedAt: Date;
  /** Source username that owns the post (for the user filter). */
  owner: string;
  /** Absolute URL to download the image bytes. */
  imageUrl: string;
  /** Absolute URL of the post page (recorded as the asset's provenance `source`). */
  postUrl: string;
}

/** Result of a source preflight — proves connectivity/auth before a run. */
export interface PreflightResult {
  actingUser: string;
  actingUserClass: string;
  /** Highest source post id to scan. */
  maxId: number;
}

/**
 * A migration source. shimmie2 is the first implementation; other boorus (Pixiv,
 * Danbooru, …) can implement the same contract and reuse the run/ledger/ingest
 * machinery. Every network call must go through the SSRF-guarded fetch.
 */
export interface SourceAdapter {
  /** Stable instance id (origin) used to key the ledger. */
  readonly sourceInstance: string;
  /** Validate connectivity + auth; return the acting user and max post id. */
  preflight(): Promise<PreflightResult>;
  /** Fetch one post's metadata (incl. rating), or null when deleted/missing. */
  fetchPost(sourcePostId: number): Promise<SourcePost | null>;
  /** Download a post's image bytes (size-capped). */
  fetchBytes(post: SourcePost): Promise<Uint8Array>;
}
