import { describe, expect, it } from "bun:test";

import { makeThumbnail } from "../src/thumbnail";

/** A 1×1 red PNG, resized to `w`×`h`, as a source image for the tests. */
async function png(width: number, height: number): Promise<Uint8Array> {
  const seed = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  return new Bun.Image(seed).resize(width, height).png().bytes();
}

describe("makeThumbnail", () => {
  it("fits a large image within the box, preserving aspect + encoding webp", async () => {
    const thumb = await makeThumbnail(await png(400, 200), 300);
    expect(thumb.width).toBe(300);
    expect(thumb.height).toBe(150);
    const meta = await new Bun.Image(thumb.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(150);
  });

  it("never upscales a source already within the box", async () => {
    const thumb = await makeThumbnail(await png(120, 80), 300);
    expect(thumb.width).toBe(120);
    expect(thumb.height).toBe(80);
    expect((await new Bun.Image(thumb.bytes).metadata()).format).toBe("webp");
  });

  it("clamps the longer side to the box for a tall image", async () => {
    const thumb = await makeThumbnail(await png(100, 500), 300);
    // 500 → 300 (scale 0.6), 100 → 60.
    expect(thumb.width).toBe(60);
    expect(thumb.height).toBe(300);
  });

  it("rejects bytes that aren't a decodable image", async () => {
    await expect(makeThumbnail(new Uint8Array([1, 2, 3, 4]), 300)).rejects.toBeDefined();
  });

  it("rejects a non-positive or non-integer maxSize", async () => {
    const src = await png(100, 100);
    await expect(makeThumbnail(src, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(makeThumbnail(src, -10)).rejects.toBeInstanceOf(RangeError);
    await expect(makeThumbnail(src, Number.NaN)).rejects.toBeInstanceOf(RangeError);
    await expect(makeThumbnail(src, 12.5)).rejects.toBeInstanceOf(RangeError);
  });
});
