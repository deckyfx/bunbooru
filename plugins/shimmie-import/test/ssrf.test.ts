import { describe, expect, it } from "bun:test";

import { isPrivateIp, SsrfError, validateTarget } from "../src/ssrf";

describe("isPrivateIp", () => {
  it("treats private / loopback / link-local IPv4 as local", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.16.0.1", "169.254.1.1", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("treats public IPv4 as non-local", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("classifies IPv6 loopback / ULA / link-local", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("validateTarget", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(validateTarget("ftp://example.com/", { credentialed: true })).rejects.toBeInstanceOf(SsrfError);
    await expect(validateTarget("file:///etc/passwd", { credentialed: false })).rejects.toBeInstanceOf(SsrfError);
  });

  it("refuses the cloud-metadata address", async () => {
    await expect(
      validateTarget("http://169.254.169.254/latest/meta-data/", { credentialed: false }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows http to a local IP (the LAN/localhost shimmie)", async () => {
    await expect(validateTarget("http://127.0.0.1:5013/graphql", { credentialed: true })).resolves.toBeUndefined();
    await expect(validateTarget("http://192.168.0.10:5013/", { credentialed: true })).resolves.toBeUndefined();
  });

  it("refuses credentials over http to a public IP", async () => {
    await expect(validateTarget("http://8.8.8.8/", { credentialed: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows https to a public IP even when credentialed", async () => {
    await expect(validateTarget("https://8.8.8.8/", { credentialed: true })).resolves.toBeUndefined();
  });

  it("allows http to a public IP when NOT credentialed", async () => {
    await expect(validateTarget("http://8.8.8.8/", { credentialed: false })).resolves.toBeUndefined();
  });
});
