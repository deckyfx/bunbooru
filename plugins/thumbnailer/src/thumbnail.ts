/** Max source pixels — decompression-bomb guard, mirrors Core's asset pipeline. */
const MAX_PIXELS = 100_000_000; // ~100 MP

/** A generated thumbnail: encoded webp bytes + its actual dimensions. */
export interface Thumbnail {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Generate a webp thumbnail that fits within a `maxSize`×`maxSize` box, preserving
 * aspect ratio and NEVER upscaling — a source already within the box is re-encoded
 * at its own dimensions. Uses Bun's native image API (`Bun.Image`), so no external
 * dependency (no sharp / ImageMagick / ffmpeg).
 *
 * @throws if the bytes aren't a decodable image or exceed the pixel-bomb guard.
 */
export async function makeThumbnail(bytes: Uint8Array, maxSize: number): Promise<Thumbnail> {
  // Guard the box size: 0/negative would yield a 1×1 (larger than "requested"),
  // and NaN would make resize dimensions invalid.
  if (!Number.isInteger(maxSize) || maxSize <= 0) {
    throw new RangeError(`maxSize must be a positive integer, got ${maxSize}`);
  }
  const meta = await new Bun.Image(bytes, { maxPixels: MAX_PIXELS }).metadata();
  // scale ≤ 1 → never upscale; fit the longer side to the box.
  const scale = Math.min(maxSize / meta.width, maxSize / meta.height, 1);
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));
  // Fresh instance for the encode pass (metadata() may consume the first).
  const out = await new Bun.Image(bytes, { maxPixels: MAX_PIXELS })
    .resize(width, height)
    .webp()
    .bytes();
  return { bytes: out, width, height };
}
