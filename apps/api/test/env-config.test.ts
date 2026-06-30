import { afterEach, describe, expect, it } from "bun:test";

import { envConfig, MAX_REQUEST_BODY_BYTES, MAX_TIMER_DELAY_MS } from "../src/env-config";

const saved = {
  SERVER_PORT: Bun.env.SERVER_PORT,
  NODE_ENV: Bun.env.NODE_ENV,
  DATABASE_URL: Bun.env.DATABASE_URL,
  STORAGE_ROOT: Bun.env.STORAGE_ROOT,
  MAX_UPLOAD_BYTES: Bun.env.MAX_UPLOAD_BYTES,
  UPLOAD_GC_INTERVAL_MS: Bun.env.UPLOAD_GC_INTERVAL_MS,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
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

describe("DATABASE_URL", () => {
  it("returns the configured connection string", () => {
    Bun.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    expect(envConfig.DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
  });

  it("throws when unset", () => {
    delete Bun.env.DATABASE_URL;
    expect(() => envConfig.DATABASE_URL).toThrow();
  });

  it("throws when empty", () => {
    Bun.env.DATABASE_URL = "";
    expect(() => envConfig.DATABASE_URL).toThrow();
  });

  it("throws when whitespace-only", () => {
    Bun.env.DATABASE_URL = "   ";
    expect(() => envConfig.DATABASE_URL).toThrow();
  });
});

describe("STORAGE_ROOT", () => {
  it("returns the configured (trimmed) value", () => {
    Bun.env.STORAGE_ROOT = "  /srv/assets  ";
    expect(envConfig.STORAGE_ROOT).toBe("/srv/assets");
  });

  it("defaults to an absolute dev path when unset", () => {
    delete Bun.env.STORAGE_ROOT;
    Bun.env.NODE_ENV = "development";
    const root = envConfig.STORAGE_ROOT;
    expect(root.startsWith("/")).toBe(true);
    expect(root.endsWith("/storage")).toBe(true);
  });

  it("is required in production", () => {
    delete Bun.env.STORAGE_ROOT;
    Bun.env.NODE_ENV = "production";
    expect(() => envConfig.STORAGE_ROOT).toThrow();
  });
});

describe("MAX_UPLOAD_BYTES", () => {
  it("defaults to 100 MB when unset", () => {
    delete Bun.env.MAX_UPLOAD_BYTES;
    expect(envConfig.MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it("parses a valid integer", () => {
    Bun.env.MAX_UPLOAD_BYTES = "5242880";
    expect(envConfig.MAX_UPLOAD_BYTES).toBe(5_242_880);
  });

  it("throws on a non-integer value", () => {
    Bun.env.MAX_UPLOAD_BYTES = "abc";
    expect(() => envConfig.MAX_UPLOAD_BYTES).toThrow();
  });

  it("throws when above the request-body ceiling", () => {
    Bun.env.MAX_UPLOAD_BYTES = String(MAX_REQUEST_BODY_BYTES + 1);
    expect(() => envConfig.MAX_UPLOAD_BYTES).toThrow();
  });
});

describe("UPLOAD_GC_INTERVAL_MS", () => {
  it("defaults to 15 minutes when unset", () => {
    delete Bun.env.UPLOAD_GC_INTERVAL_MS;
    expect(envConfig.UPLOAD_GC_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("parses a valid integer", () => {
    Bun.env.UPLOAD_GC_INTERVAL_MS = "60000";
    expect(envConfig.UPLOAD_GC_INTERVAL_MS).toBe(60_000);
  });

  it("accepts 0 to disable the sweep", () => {
    Bun.env.UPLOAD_GC_INTERVAL_MS = "0";
    expect(envConfig.UPLOAD_GC_INTERVAL_MS).toBe(0);
  });

  it("throws on a negative value", () => {
    Bun.env.UPLOAD_GC_INTERVAL_MS = "-1";
    expect(() => envConfig.UPLOAD_GC_INTERVAL_MS).toThrow();
  });

  it("throws above the timer ceiling", () => {
    Bun.env.UPLOAD_GC_INTERVAL_MS = String(MAX_TIMER_DELAY_MS + 1);
    expect(() => envConfig.UPLOAD_GC_INTERVAL_MS).toThrow();
  });
});
