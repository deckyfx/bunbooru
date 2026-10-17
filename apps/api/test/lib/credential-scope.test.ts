import { describe, expect, it } from "bun:test";

import { credentialAllows } from "../../src/lib/credential-scope";

describe("credentialAllows", () => {
  it("lets sessions, full keys and anonymous requests through (routes do their own checks)", () => {
    for (const kind of ["session", "full", null] as const) {
      expect(credentialAllows(kind, "DELETE", "/api/v1/account/api-keys/:id")).toBe(true);
    }
  });

  it("confines an upload key to uploading, whoami and tag lookup", () => {
    expect(credentialAllows("upload", "POST", "/api/v1/assets")).toBe(true);
    expect(credentialAllows("upload", "post", "/api/v1/assets")).toBe(true);
    expect(credentialAllows("upload", "PATCH", "/api/v1/uploads/:token")).toBe(true);
    expect(credentialAllows("upload", "GET", "/api/v1/auth/me")).toBe(true);
    expect(credentialAllows("upload", "GET", "/api/v1/tags")).toBe(true);

    expect(credentialAllows("upload", "GET", "/api/v1/assets")).toBe(false);
    expect(credentialAllows("upload", "PATCH", "/api/v1/assets/:id")).toBe(false);
    expect(credentialAllows("upload", "POST", "/api/v1/account/api-keys")).toBe(false);
    expect(credentialAllows("upload", "GET", "/api/v1/admin/jobs")).toBe(false);
  });
});
