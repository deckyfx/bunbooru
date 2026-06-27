import { afterEach, describe, expect, it } from "bun:test";

import { envConfig } from "../src/env-config";

const original = Bun.env.SERVER_PORT;

afterEach(() => {
  if (original === undefined) delete Bun.env.SERVER_PORT;
  else Bun.env.SERVER_PORT = original;
});

describe("SERVER_PORT", () => {
  it("defaults to 3000 when unset", () => {
    delete Bun.env.SERVER_PORT;
    expect(envConfig.SERVER_PORT).toBe(3000);
  });

  it("parses a valid port", () => {
    Bun.env.SERVER_PORT = "8080";
    expect(envConfig.SERVER_PORT).toBe(8080);
  });

  it("throws on a non-numeric value", () => {
    Bun.env.SERVER_PORT = "abc";
    expect(() => envConfig.SERVER_PORT).toThrow();
  });

  it("throws on an out-of-range port", () => {
    Bun.env.SERVER_PORT = "70000";
    expect(() => envConfig.SERVER_PORT).toThrow();
  });
});
