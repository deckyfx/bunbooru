import { afterEach, describe, expect, it } from "bun:test";

import { envConfig } from "../src/env-config";

const original = Bun.env.SERVER_PORT;
const originalNodeEnv = Bun.env.NODE_ENV;

afterEach(() => {
  if (original === undefined) delete Bun.env.SERVER_PORT;
  else Bun.env.SERVER_PORT = original;
  if (originalNodeEnv === undefined) delete Bun.env.NODE_ENV;
  else Bun.env.NODE_ENV = originalNodeEnv;
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

describe("NODE_ENV", () => {
  it("fails closed to production when unset", () => {
    delete Bun.env.NODE_ENV;
    expect(envConfig.NODE_ENV).toBe("production");
    expect(envConfig.isDevelopment).toBe(false);
  });

  it("is development only when explicitly set", () => {
    Bun.env.NODE_ENV = "development";
    expect(envConfig.isDevelopment).toBe(true);
  });

  it("throws on an unsupported value", () => {
    Bun.env.NODE_ENV = "staging";
    expect(() => envConfig.NODE_ENV).toThrow();
  });
});
