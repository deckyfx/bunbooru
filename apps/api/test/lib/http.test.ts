import { describe, expect, it } from "bun:test";

import { HttpError } from "../../src/lib/errors";
import { readRequestId, safeMessage, statusFor } from "../../src/lib/http";

describe("statusFor", () => {
  it("uses an HttpError's own status", () => {
    expect(statusFor("UNKNOWN", new HttpError(418, "teapot"))).toBe(418);
  });

  it("maps known Elysia codes", () => {
    expect(statusFor("NOT_FOUND", new Error())).toBe(404);
    expect(statusFor("VALIDATION", new Error())).toBe(422);
    expect(statusFor("PARSE", new Error())).toBe(400);
  });

  it("defaults unknown codes to 500", () => {
    expect(statusFor("UNKNOWN", new Error())).toBe(500);
    expect(statusFor(123, new Error())).toBe(500);
  });
});

describe("readRequestId", () => {
  it("returns the id when present", () => {
    expect(readRequestId({ "x-request-id": "abc" })).toBe("abc");
  });

  it("returns undefined when absent or non-string", () => {
    expect(readRequestId({})).toBeUndefined();
    expect(readRequestId({ "x-request-id": 123 })).toBeUndefined();
  });
});

describe("safeMessage", () => {
  it("masks 5xx detail outside development", () => {
    expect(safeMessage(500, "db exploded", false)).toBe("Internal Server Error");
  });

  it("keeps 5xx detail in development", () => {
    expect(safeMessage(500, "db exploded", true)).toBe("db exploded");
  });

  it("always keeps 4xx detail", () => {
    expect(safeMessage(404, "Not Found", false)).toBe("Not Found");
    expect(safeMessage(422, "bad field", false)).toBe("bad field");
  });
});
