#!/usr/bin/env bun
/**
 * Seed the gallery with generated placeholder images (dev only).
 *
 * Usage: bun run seed [count]   (default 24)
 *
 * Builds small solid-colour PNGs of varied size/hue — each a unique byte stream,
 * so dedupe doesn't collapse them — and ingests each through the real upload
 * service (hash → store → insert). Run from the repo root so it shares the same
 * `data/storage` root the API serves from (its STORAGE_ROOT default, `resolve(cwd,
 * "data/storage")`); override with STORAGE_ROOT to point elsewhere.
 */
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { createCore } from "@bunbooru/core";

/** Precomputed CRC-32 table (PNG chunk checksums). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

/** Frame a PNG chunk: length + type + data + CRC. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** A PNG `tEXt` chunk (`keyword\0text`) — an ancillary chunk decoders ignore. */
function textChunk(keyword: string, text: string): Uint8Array {
  return chunk("tEXt", new TextEncoder().encode(`${keyword}\0${text}`));
}

/**
 * Encode a `width × height` solid-RGB PNG. An optional `nonce` is embedded as a
 * `tEXt` chunk so otherwise-identical images (same size + colour) still produce
 * distinct bytes — without it the generator only has lcm(5, 360) = 1800 unique
 * outputs and the upload service would dedupe everything past that.
 */
function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
  nonce?: string,
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  // Raw scanlines: a 0 (no-filter) byte then RGB triples per pixel.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat)];
  if (nonce !== undefined) parts.push(textChunk("Comment", nonce));
  parts.push(chunk("IEND", new Uint8Array(0)));
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** HSL (h in degrees, s/l in 0..1) → 8-bit RGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("✖ DATABASE_URL is required to seed");
  process.exit(1);
}

const core = createCore({
  databaseUrl,
  storageRoot: Bun.env.STORAGE_ROOT?.trim() || resolve(process.cwd(), "data/storage"),
  // The seeder uses assetService.create directly (not the resumable uploader),
  // so this bound is unused here; keep it generous.
  maxResumableUploadBytes: 100 * 1024 * 1024,
  // Unused by the seeder (it never opens a session); any positive value works.
  sessionExpiryMs: 30 * 24 * 60 * 60 * 1000,
});

/** Aspect variety so the masonry layout has something to do. */
const SHAPES: ReadonlyArray<readonly [number, number]> = [
  [800, 600],
  [600, 800],
  [720, 720],
  [1024, 576],
  [512, 900],
];

const rawCount = Bun.argv[2];
const count = rawCount == null ? 24 : Number(rawCount);
if (!Number.isInteger(count) || count < 0) {
  console.error(`✖ count must be a non-negative integer, got "${rawCount}"`);
  process.exit(1);
}
let created = 0;
let deduped = 0;
for (let i = 0; i < count; i++) {
  const [width, height] = SHAPES[i % SHAPES.length] ?? [600, 600];
  // Per-image nonce keeps every byte stream unique, so a large `count` actually
  // creates `count` assets instead of deduping once the shape/hue cycle repeats.
  const bytes = solidPng(width, height, hslToRgb((i * 47) % 360, 0.62, 0.58), `seed-${i}`);
  const result = await core.assetService.create({ bytes });
  if (result.deduped) deduped++;
  else created++;
}

console.log(`✔ seeded ${created} new asset(s), ${deduped} already existed`);
process.exit(0);
