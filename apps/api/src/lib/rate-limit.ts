/**
 * A tiny in-memory fixed-window rate limiter. Deployment is single-instance, so a
 * process-local map is sufficient (a multi-instance deployment would need a
 * shared store like Redis — a follow-up). Buckets expire lazily and the map is
 * pruned when it grows, so spoofed keys can't leak memory unbounded.
 */
export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max hits allowed per key within a window. */
  max: number;
}

export interface RateLimiter {
  /** Record a hit for `key`; returns false when the key is over its limit. */
  hit(key: string): boolean;
}

/** Cap on tracked keys — prune expired buckets before exceeding it. */
const MAX_TRACKED_KEYS = 10_000;

/** Build a fixed-window {@link RateLimiter}. */
export function createRateLimiter({ windowMs, max }: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    hit(key) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        if (buckets.size >= MAX_TRACKED_KEYS) {
          prune(now);
          // If pruning freed nothing (all buckets live), refuse rather than grow
          // the map without bound — fail closed under a many-distinct-IP flood.
          if (buckets.size >= MAX_TRACKED_KEYS) return false;
        }
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
  };
}

/**
 * The slice of Bun's `Server` we need — structural so we don't depend on the
 * generic `Server<WebSocketData>` shape Elysia hands us.
 */
interface IpResolver {
  requestIP(request: Request): { address: string } | null;
}

/**
 * Client IP for rate-limit keying. The socket address is authoritative and
 * un-spoofable; `X-Forwarded-For` is only consulted when `trustProxy` is set,
 * because XFF is client-supplied and would otherwise let an attacker rotate it to
 * bypass the auth throttles. Enable `trustProxy` only behind a reverse proxy that
 * overwrites the header (see `TRUST_PROXY`).
 */
export function clientIp(request: Request, server: IpResolver | null, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  return server?.requestIP(request)?.address ?? "unknown";
}
