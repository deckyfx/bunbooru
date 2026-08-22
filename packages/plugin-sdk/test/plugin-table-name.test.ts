import { describe, expect, it } from "bun:test";

import { pluginTableName } from "../src/index";

describe("pluginTableName", () => {
  it("normalizes both parts to a safe identifier and joins them", () => {
    expect(pluginTableName("smtp-mailer", "outbox")).toBe("smtp_mailer_outbox");
    expect(pluginTableName("smtp-mailer", "outbox-items")).toBe("smtp_mailer_outbox_items");
    expect(pluginTableName("Thumbnailer", "Thumbnails")).toBe("thumbnailer_thumbnails");
  });

  it("collapses non-alphanumeric runs and strips non-ASCII", () => {
    expect(pluginTableName("a..b", "c  d")).toBe("a_b_c_d");
    // Accented chars are stripped (→ separator), so the result stays pure ASCII.
    expect(pluginTableName("café", "menu")).toBe("caf_menu");
  });

  it("rejects parts that are empty after normalization", () => {
    expect(() => pluginTableName("smtp-mailer", "")).toThrow();
    expect(() => pluginTableName("", "outbox")).toThrow();
    expect(() => pluginTableName("smtp-mailer", "___")).toThrow();
  });

  it("rejects a result that would start with a digit (invalid unquoted identifier)", () => {
    expect(() => pluginTableName("123", "outbox")).toThrow();
  });

  it("rejects a result over Postgres's 63-byte identifier limit", () => {
    expect(() => pluginTableName("p", "x".repeat(62))).toThrow(); // "p_" + 62 = 64
    expect(pluginTableName("p", "x".repeat(61))).toHaveLength(63); // boundary OK
  });
});
