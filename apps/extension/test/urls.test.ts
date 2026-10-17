import { describe, expect, it } from "bun:test";

import { filenameFor, imageUrlProblem, normalizeServerUrl, originPattern, parseTags } from "../src/lib/urls";

describe("normalizeServerUrl", () => {
  it("keeps only the origin, adding https when no scheme is typed", () => {
    expect(normalizeServerUrl(" https://booru.example/posts?x=1 ")).toEqual({ origin: "https://booru.example" });
    expect(normalizeServerUrl("booru.example:8443")).toEqual({ origin: "https://booru.example:8443" });
    expect(normalizeServerUrl("http://192.168.0.10:3000")).toEqual({ origin: "http://192.168.0.10:3000" });
  });

  it("explains what's wrong", () => {
    expect(normalizeServerUrl("")).toHaveProperty("problem");
    expect(normalizeServerUrl("ftp://booru.example")).toEqual({ problem: "Use an http(s) address." });
    expect(normalizeServerUrl("https://")).toHaveProperty("problem");
  });
});

describe("imageUrlProblem", () => {
  it("allows web addresses and inline images", () => {
    expect(imageUrlProblem("https://cdn.example/a.png")).toBeNull();
    expect(imageUrlProblem("http://lan.local/a.png")).toBeNull();
    expect(imageUrlProblem("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
  });

  it("refuses everything else", () => {
    for (const src of ["file:///etc/passwd", "chrome://settings", "chrome-extension://abc/x.png", "javascript:alert(1)"]) {
      expect(imageUrlProblem(src)).not.toBeNull();
    }
    expect(imageUrlProblem("data:text/html,<b>x</b>")).toBe("Not an image.");
    expect(imageUrlProblem("blob:https://site.example/uuid")).toMatch(/inside the page/);
    expect(imageUrlProblem("not a url")).not.toBeNull();
  });
});

describe("filenameFor", () => {
  it("takes the last path segment, sanitized, adding an extension when missing", () => {
    expect(filenameFor("https://cdn.example/art/My%20Pic.png?x=1", "image/png")).toBe("My_Pic.png");
    expect(filenameFor("https://pbs.example/media/AbC123", "image/jpeg")).toBe("AbC123.jpg");
  });

  it("falls back to a generic name", () => {
    expect(filenameFor("https://cdn.example/", "image/webp")).toBe("image.webp");
    expect(filenameFor("data:image/gif;base64,R0lG", "image/gif")).toBe("image.gif");
    expect(filenameFor("https://cdn.example/", "")).toBe("image.img");
  });
});

describe("parseTags", () => {
  it("splits on whitespace, lowercases and dedupes", () => {
    expect(parseTags("  Cat sky\ncat  blue_sky ")).toEqual(["cat", "sky", "blue_sky"]);
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("originPattern", () => {
  it("builds a host permission pattern for web origins only", () => {
    expect(originPattern("https://cdn.example:8443/a.png")).toBe("https://cdn.example:8443/*");
    expect(originPattern("data:image/png;base64,x")).toBeNull();
    expect(originPattern("nope")).toBeNull();
  });
});
