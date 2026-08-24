import { describe, expect, it } from "bun:test";

import { formatJson, formatPretty } from "../src/lib/logger";

const AT = new Date("2026-01-01T00:00:00.000Z");

/** A parsed log line. Values are `unknown` — assertions narrow them. */
type LogRecord = Record<string, unknown>;

/**
 * Parse a rendered line, validating it really is a JSON object.
 *
 * `JSON.parse` returns `any`, which would silently disable type checking on every
 * assertion below (and CLAUDE.md forbids `any`). This narrows once, here.
 */
function parseLine(json: string): LogRecord {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object, got: ${json}`);
  }
  return parsed as LogRecord;
}

/**
 * JSON log rendering. The stakes are higher than formatting: `JSON.stringify`
 * throws on a `bigint` and on a cyclic structure, and a logger that throws takes
 * the request with it — turning a diagnostic into an outage.
 */
describe("formatJson", () => {
  it("renders level, time and message alongside the fields", () => {
    expect(parseLine(formatJson("info", "asset_created", { id: 7 }, AT))).toEqual({
      level: "info",
      time: "2026-01-01T00:00:00.000Z",
      message: "asset_created",
      id: 7,
    });
  });

  it("never lets a field overwrite the reserved metadata", () => {
    const line = parseLine(
      formatJson("error", "real_message", { level: "info", message: "spoofed", time: "then" }, AT),
    );
    expect(line.level).toBe("error");
    expect(line.message).toBe("real_message");
    expect(line.time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("serializes a bigint instead of throwing", () => {
    expect(parseLine(formatJson("info", "size", { bytes: 9_007_199_254_740_993n }, AT)).bytes).toBe(
      "9007199254740993",
    );
  });

  it("survives a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const line = parseLine(formatJson("warn", "cycle", { cyclic }, AT));
    expect(line.message).toBe("cycle");
    expect(line.cyclic).toEqual({ name: "loop", self: "[circular]" });
  });

  it("keeps an Error's message, which plain stringify would drop", () => {
    // `JSON.stringify(new Error("boom"))` is `{}` — the one field that matters.
    const line = parseLine(formatJson("error", "failed", { error: new Error("boom") }, AT));
    expect(line.error).toEqual({ name: "Error", message: "boom" });
  });

  it("falls back to metadata-only when a NESTED getter throws", () => {
    // Invoked by JSON.stringify, inside the try.
    const hostile = {
      get exploding(): never {
        throw new Error("getter boom");
      },
    };
    const line = parseLine(formatJson("error", "still_logged", { hostile }, AT));
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
    const line = parseLine(formatJson("error", "still_logged", fields, AT));
    expect(line.message).toBe("still_logged");
    expect(line.fields).toBe("[unserializable]");
  });
});

/**
 * Pretty rendering carries the same obligation: it is the DEFAULT in development,
 * so a throwing field must not break the dev server's log line either.
 */
describe("formatPretty", () => {
  it("renders time, level, message and dimmed fields without colour off a TTY", () => {
    const line = formatPretty("info", "plugin_loaded", { id: "example", routes: true }, AT, false);
    expect(line).toContain("INFO ");
    expect(line).toContain("plugin_loaded");
    expect(line).toContain("id=example");
    expect(line).toContain("routes=true");
    expect(line).not.toContain("\x1b[");
  });

  it("quotes values containing whitespace so `k=v` can't be misread", () => {
    expect(formatPretty("info", "note", { text: "cold start" }, AT, false)).toContain(
      'text="cold start"',
    );
  });

  it("marks a throwing field but still renders the others", () => {
    // Object.entries would have invoked every getter up front; one throwing getter
    // would then lose the whole line. Per-field guarding keeps the rest readable.
    const fields = {
      safe: "kept",
      get boom(): never {
        throw new Error("getter boom");
      },
    };
    expect(() => formatPretty("error", "still_logged", fields, AT, false)).not.toThrow();
    const line = formatPretty("error", "still_logged", fields, AT, false);
    expect(line).toContain("still_logged");
    expect(line).toContain("safe=kept");
    expect(line).toContain("boom=[unserializable]");
  });
});
