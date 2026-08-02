import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Raised when a target URL fails the SSRF guard. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Cloud-metadata endpoints — always refused, even though 169.254/16 is link-local. */
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "fd00:ec2::254"]);

function isMetadata(host: string): boolean {
  return METADATA_HOSTS.has(host.toLowerCase());
}

/**
 * Whether an IP literal is private / loopback / link-local — i.e. "local". Used
 * to decide whether http-with-credentials is permitted (only to a local host)
 * and treated conservatively: an unparseable value is NOT considered local.
 */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = parts as [number, number, number, number];
    return (
      a === 0 || // 0.0.0.0/8 ("this host")
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // link-local
    );
  }
  if (version === 6) {
    const v6 = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) → classify by the embedded v4.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateIp(mapped[1]);
    if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
    // Compare the NUMERIC first hextet, not a string prefix: canonical IPv6 strips
    // leading zeros, so "fc1::" (0x0fc1) starts with "fc" yet is NOT in fc00::/7 —
    // a string prefix would fail open (classify a public address as local).
    const firstHextet = Number.parseInt(v6.split(":")[0] || "", 16);
    if (Number.isNaN(firstHextet)) return false;
    return (
      (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) || // unique-local fc00::/7
      (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) // link-local fe80::/10
    );
  }
  return false;
}

/** Options controlling the guard's credential/scheme policy. */
export interface GuardOptions {
  /** True when the request carries a secret (api_key/cookie) → https required for non-local hosts. */
  credentialed: boolean;
  /** Permit http to a resolved-local host (the LAN/localhost shimmie). Default true. */
  allowInsecureLocal?: boolean;
}

/**
 * Validate a target URL and classify its resolved host: reject non-http(s)
 * schemes and cloud-metadata addresses, and — when the request is credentialed —
 * refuse http to a non-local host (a stray/leaking key over plaintext to the
 * internet). A host is "local" only when EVERY resolved address is private.
 */
export async function validateTarget(rawUrl: string, opts: GuardOptions): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("Only http and https URLs are allowed");
  }
  const host = url.hostname;
  if (isMetadata(host)) throw new SsrfError("Refusing to fetch a cloud-metadata address");

  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    const resolved = await lookup(host, { all: true }).catch(() => {
      throw new SsrfError(`Cannot resolve host: ${host}`);
    });
    ips = resolved.map((entry) => entry.address);
    if (ips.length === 0) throw new SsrfError(`Cannot resolve host: ${host}`);
  }
  if (ips.some(isMetadata)) throw new SsrfError("Host resolves to a cloud-metadata address");

  const local = ips.every(isPrivateIp);
  if (opts.credentialed && url.protocol !== "https:") {
    const allowLocal = opts.allowInsecureLocal ?? true;
    if (!(local && allowLocal)) {
      throw new SsrfError(
        "Refusing to send credentials over http to a non-local host — use https",
      );
    }
  }
}

/** Options for {@link guardedFetch}. */
export interface GuardedFetchOptions extends GuardOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort the request after this long (default 15s). */
  timeoutMs?: number;
  /** Max redirects to follow, each re-validated (default 3). */
  maxRedirects?: number;
}

/**
 * `fetch` with the SSRF guard applied to the initial URL AND every redirect
 * target, a timeout, and manual redirect handling (so a 3xx `Location` pointing
 * at an internal address is re-validated, not blindly followed). The caller is
 * responsible for a response-size cap via {@link readBytesCapped}. Credentials
 * (api_key in the URL) are never appended to a redirect target — only the initial
 * URL the caller built carries them.
 *
 * NOTE (accepted limitation): {@link validateTarget} resolves DNS, then `fetch`
 * resolves again at connect time, so a hostname whose DNS record flips between
 * the two lookups (DNS rebinding) could bypass the guard. Pinning the validated
 * IP for the connection is DEFERRED — this is the deliberate "pragmatic" scope
 * for an admin-only, self-hosted importer targeting a LAN/localhost shimmie
 * (typically an IP literal, which has no DNS to rebind). Bun's `fetch` also lacks
 * Node/undici's dispatcher-level DNS-pinning. Revisit if a less-trusted role can
 * ever set the source host.
 */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  let currentUrl = rawUrl;

  for (let hop = 0; ; hop += 1) {
    await validateTarget(currentUrl, opts);
    const res = await fetch(currentUrl, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new SsrfError("Too many redirects");
    currentUrl = new URL(location, currentUrl).toString();
  }
}

/**
 * Read a response body into memory with a hard byte cap, aborting (and throwing)
 * once exceeded — so a hostile/huge source image can't exhaust memory.
 */
export async function readBytesCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SsrfError(`Response exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
