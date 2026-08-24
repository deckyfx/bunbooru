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

  it("falls back to metadata-only when a NESTED getter throws", () => {
    // Invoked by JSON.stringify, inside the try.
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

  it("falls back when a getter on FIELDS ITSELF throws", () => {
    // Distinct from the nested case: expanding `fields` invokes this getter, so it
    // fires during the spread rather than during serialization. With the spread
    // outside the try, this escaped the fallback and took the request with it.
    const fields = {
      get boom(): never {
        throw new Error("spread boom");
      },
    };
    expect(() => formatJson("error", "still_logged", fields, AT)).not.toThrow();
    const line = JSON.parse(formatJson("error", "still_logged", fields, AT));
    expect(line.message).toBe("still_logged");
    expect(line.fields).toBe("[unserializable]");
  });
});
