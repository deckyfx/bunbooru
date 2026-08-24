import { describe, expect, it } from "bun:test";

import { formatJson } from "../src/lib/logger";

const AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * JSON log rendering. The stakes here are higher than formatting: `JSON.stringify`
 * throws on a `bigint` and on a cyclic structure, and a logger that throws takes
 * the request with it — turning a diagnostic into an outage.
 */
describe("formatJson", () => {
  it("renders level, time and message alongside the fields", () => {
    const line = JSON.parse(formatJson("info", "asset_created", { id: 7 }, AT));
    expect(line).toEqual({
      level: "info",
      time: "2026-01-01T00:00:00.000Z",
      message: "asset_created",
      id: 7,
    });
  });

  it("never lets a field overwrite the reserved metadata", () => {
    const line = JSON.parse(
      formatJson("error", "real_message", { level: "info", message: "spoofed", time: "then" }, AT),
    );
    expect(line.level).toBe("error");
    expect(line.message).toBe("real_message");
    expect(line.time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("serializes a bigint instead of throwing", () => {
    const line = JSON.parse(formatJson("info", "size", { bytes: 9_007_199_254_740_993n }, AT));
    expect(line.bytes).toBe("9007199254740993");
  });

  it("survives a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const line = JSON.parse(formatJson("warn", "cycle", { cyclic }, AT));
    expect(line.message).toBe("cycle");
    expect(line.cyclic.name).toBe("loop");
    expect(line.cyclic.self).toBe("[circular]");
  });

  it("keeps an Error's message, which plain stringify would drop", () => {
    // `JSON.stringify(new Error("boom"))` is `{}` — the one field that matters.
    const line = JSON.parse(formatJson("error", "failed", { error: new Error("boom") }, AT));
    expect(line.error).toEqual({ name: "Error", message: "boom" });
  });

  it("falls back to metadata-only rather than losing the line", () => {
    const hostile = {
      get exploding(): never {
        throw new Error("getter boom");
      },
    };
    const line = JSON.parse(formatJson("error", "still_logged", { hostile }, AT));
    expect(line.message).toBe("still_logged");
    expect(line.level).toBe("error");
    expect(line.fields).toBe("[unserializable]");
  });
});
