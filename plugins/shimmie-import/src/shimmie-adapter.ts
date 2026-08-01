import type { PreflightResult, SourceAdapter, SourcePost, SourceRating } from "./source-adapter";
import { guardedFetch, readBytesCapped, SsrfError } from "./ssrf";

/** Hard cap on a single downloaded source image (bytes). */
const MAX_IMAGE_BYTES = 100 * 1024 * 1024; // 100 MB

/** shimmie one-char rating → bunbooru rating. */
const RATING_MAP: Record<string, SourceRating> = {
  s: "safe",
  q: "questionable",
  e: "explicit",
  "?": "unrated",
};

/** Shape of a shimmie GraphQL `Post` (the fields the importer requests). */
interface ShimmiePost {
  hash: string;
  ext: string;
  width: number;
  height: number;
  mime: string | null;
  source: string | null;
  posted: string;
  owner: { name: string };
  tags: string[];
  image_link: string;
}

export interface ShimmieConfig {
  /** Base URL of the shimmie install, e.g. `http://localhost:5013`. */
  baseUrl: string;
  /** shimmie User-API key (secret) — sent as `?api_key=`. */
  apiKey: string;
  /**
   * IANA timezone the source's naive `posted` timestamps are in (default `UTC` —
   * correct for the standard Docker image). Configurable per source since each
   * shimmie install runs in its own server timezone.
   */
  timezone?: string;
}

/** The zone's offset (ms) at `instant` — i.e. `zoneWallClock - utc`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asIfUtc - instant.getTime();
}

/**
 * Parse shimmie's `posted` ("YYYY-MM-DD HH:MM:SS") — a naive wall-clock time in
 * the source server's `timeZone` — into a correct UTC {@link Date}. Computes the
 * zone's offset AT that instant, so it's DST-correct (not a fixed offset). An
 * invalid timezone (or unparseable value) falls back safely so a bad input never
 * throws mid-import.
 */
function parsePosted(posted: string, timeZone: string): Date {
  const asUtc = new Date(`${posted.replace(" ", "T")}Z`);
  if (Number.isNaN(asUtc.getTime())) return new Date();
  try {
    // `asUtc` reads as `posted` on a UTC clock; subtracting the target zone's
    // offset at that instant yields the real UTC time the wall clock referred to.
    return new Date(asUtc.getTime() - zoneOffsetMs(asUtc, timeZone));
  } catch {
    return asUtc; // unknown timezone → treat the value as UTC
  }
}

/**
 * shimmie2 source adapter over its GraphQL + User-API extensions. Auth rides the
 * `?api_key=` query param (the header form does not authenticate); rating is not
 * in GraphQL, so it's scraped from the post page's stable `data-rating`
 * attribute. Every request goes through the SSRF-guarded fetch.
 */
export class ShimmieAdapter implements SourceAdapter {
  readonly sourceInstance: string;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timezone: string;

  constructor(config: ShimmieConfig) {
    // Normalize to the origin (scheme + host + port), no path/trailing slash.
    const url = new URL(config.baseUrl);
    this.base = url.origin;
    this.sourceInstance = url.origin;
    this.apiKey = config.apiKey;
    this.timezone = config.timezone ?? "UTC";
  }

  /** Append the api_key to a path under the base. */
  private url(path: string): string {
    const sep = path.includes("?") ? "&" : "?";
    return `${this.base}${path}${sep}api_key=${encodeURIComponent(this.apiKey)}`;
  }

  private async graphql<T>(query: string): Promise<T> {
    const res = await guardedFetch(this.url("/graphql"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      credentialed: true,
    });
    if (res.status === 404) {
      throw new Error("GraphQL endpoint not found — enable the GraphQL extension on shimmie");
    }
    if (!res.ok) throw new Error(`GraphQL request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0]?.message}`);
    if (json.data === undefined) throw new Error("GraphQL returned no data");
    return json.data;
  }

  async preflight(): Promise<PreflightResult> {
    const data = await this.graphql<{ me: { name: string; class: { name: string } } }>(
      "{ me { name class { name } } }",
    );
    if (!data.me || data.me.name === "Anonymous") {
      throw new Error(
        "Not authenticated — check the api_key and that the User API extension is enabled (resolved as Anonymous)",
      );
    }
    const maxId = await this.fetchMaxId();
    return { actingUser: data.me.name, actingUserClass: data.me.class.name, maxId };
  }

  /** Highest post id — the newest post on `/post/list/1`. */
  private async fetchMaxId(): Promise<number> {
    const res = await guardedFetch(this.url("/post/list/1"), { credentialed: true });
    if (!res.ok) throw new Error(`Cannot read the post list: HTTP ${res.status}`);
    const html = await res.text();
    let max = 0;
    for (const match of html.matchAll(/\/post\/view\/(\d+)/g)) {
      const id = Number(match[1]);
      if (id > max) max = id;
    }
    return max;
  }

  async fetchPost(sourcePostId: number): Promise<SourcePost | null> {
    const data = await this.graphql<{ post: ShimmiePost | null }>(
      `{ post(post_id: ${sourcePostId}) { hash ext width height mime source posted owner { name } tags image_link } }`,
    );
    const post = data.post;
    if (!post) return null;
    return {
      sourcePostId,
      md5: post.hash,
      ext: post.ext,
      mimeType: post.mime ?? null,
      width: post.width,
      height: post.height,
      tags: post.tags,
      source: post.source ?? null,
      rating: await this.fetchRating(sourcePostId),
      postedAt: parsePosted(post.posted, this.timezone),
      owner: post.owner.name,
      imageUrl: new URL(post.image_link, this.base).toString(),
      postUrl: `${this.base}/post/view/${sourcePostId}`,
    };
  }

  /** GraphQL has no rating; read the post page's `data-rating` attribute. */
  private async fetchRating(sourcePostId: number): Promise<SourceRating> {
    const res = await guardedFetch(this.url(`/post/view/${sourcePostId}`), { credentialed: true });
    if (!res.ok) return "unrated";
    const html = await res.text();
    const match = html.match(/data-rating=['"]([sqe?])['"]/);
    const code = match?.[1];
    return (code && RATING_MAP[code]) || "unrated";
  }

  async fetchBytes(post: SourcePost): Promise<Uint8Array> {
    // `credentialed: false` — the image URL carries no api_key (shimmie image
    // files aren't access-controlled), so the guard needn't force https for it.
    const res = await guardedFetch(post.imageUrl, { credentialed: false });
    if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
    return readBytesCapped(res, MAX_IMAGE_BYTES);
  }
}

export { SsrfError };
