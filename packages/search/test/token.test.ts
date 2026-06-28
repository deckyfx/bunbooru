import { describe, expect, it } from "bun:test";

import { tokenize } from "../src/token";

describe("tokenize", () => {
  it("splits whitespace-separated tags", () => {
    expect(tokenize("1girl solo")).toEqual([
      { kind: "tag", prefix: "none", name: "1girl" },
      { kind: "tag", prefix: "none", name: "solo" },
    ]);
  });

  it("lowercases tag names", () => {
    expect(tokenize("BlueEyes")).toEqual([{ kind: "tag", prefix: "none", name: "blueeyes" }]);
  });

  it("marks negation with the - prefix", () => {
    expect(tokenize("-monochrome")).toEqual([
      { kind: "tag", prefix: "not", name: "monochrome" },
    ]);
  });

  it("marks or-group members with the ~ prefix", () => {
    expect(tokenize("~a ~b")).toEqual([
      { kind: "tag", prefix: "or", name: "a" },
      { kind: "tag", prefix: "or", name: "b" },
    ]);
  });

  it("parses metatags into key/value with a lowercased key", () => {
    expect(tokenize("Rating:safe")).toEqual([
      { kind: "metatag", prefix: "none", key: "rating", value: "safe" },
    ]);
  });

  it("keeps operator and range characters in the metatag value", () => {
    expect(tokenize("score:>10")).toEqual([
      { kind: "metatag", prefix: "none", key: "score", value: ">10" },
    ]);
    expect(tokenize("width:100..200")).toEqual([
      { kind: "metatag", prefix: "none", key: "width", value: "100..200" },
    ]);
  });

  it("carries the prefix onto metatags", () => {
    expect(tokenize("-rating:explicit")).toEqual([
      { kind: "metatag", prefix: "not", key: "rating", value: "explicit" },
    ]);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(tokenize("  1girl   solo  ")).toEqual([
      { kind: "tag", prefix: "none", name: "1girl" },
      { kind: "tag", prefix: "none", name: "solo" },
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("drops a bare - or ~", () => {
    expect(tokenize("- ~ 1girl")).toEqual([{ kind: "tag", prefix: "none", name: "1girl" }]);
  });
});
