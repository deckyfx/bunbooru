import { describe, expect, it } from "bun:test";

import { maskEmail } from "../src/mask";

describe("maskEmail", () => {
  it("keeps the first/last local char and the full domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a***e@example.com");
  });

  it("fully masks a short local part", () => {
    expect(maskEmail("ab@example.com")).toBe("***@example.com");
    expect(maskEmail("a@example.com")).toBe("***@example.com");
  });

  it("treats a value with no usable @ as opaque", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
  });
});
