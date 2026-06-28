import { describe, expect, it } from "bun:test";

import { parse } from "../src/parser";

describe("parse", () => {
  it("empty query → empty AND", () => {
    expect(parse("")).toEqual({ type: "and", children: [] });
  });

  it("single tag → AND[tag]", () => {
    expect(parse("1girl")).toEqual({
      type: "and",
      children: [{ type: "tag", name: "1girl" }],
    });
  });

  it("implicitly ANDs multiple tags", () => {
    expect(parse("1girl solo")).toEqual({
      type: "and",
      children: [
        { type: "tag", name: "1girl" },
        { type: "tag", name: "solo" },
      ],
    });
  });

  it("wraps a negated term in NOT", () => {
    expect(parse("1girl -monochrome")).toEqual({
      type: "and",
      children: [
        { type: "tag", name: "1girl" },
        { type: "not", child: { type: "tag", name: "monochrome" } },
      ],
    });
  });

  it("combines ~ terms into one OR group, AND'd with the rest", () => {
    expect(parse("1girl ~blue_eyes ~green_eyes")).toEqual({
      type: "and",
      children: [
        { type: "tag", name: "1girl" },
        {
          type: "or",
          children: [
            { type: "tag", name: "blue_eyes" },
            { type: "tag", name: "green_eyes" },
          ],
        },
      ],
    });
  });

  it("treats a lone ~term as just that term (no OR wrapper)", () => {
    expect(parse("~solo")).toEqual({
      type: "and",
      children: [{ type: "tag", name: "solo" }],
    });
  });

  it("parses an equality metatag", () => {
    expect(parse("rating:safe")).toEqual({
      type: "and",
      children: [{ type: "metatag", key: "rating", op: "eq", value: "safe" }],
    });
  });

  it("parses comparison metatags (longest operator first)", () => {
    const op = (q: string) => parse(q).children[0];
    expect(op("score:>10")).toEqual({ type: "metatag", key: "score", op: "gt", value: "10" });
    expect(op("score:>=10")).toEqual({ type: "metatag", key: "score", op: "gte", value: "10" });
    expect(op("score:<10")).toEqual({ type: "metatag", key: "score", op: "lt", value: "10" });
    expect(op("score:<=10")).toEqual({ type: "metatag", key: "score", op: "lte", value: "10" });
  });

  it("parses a range metatag", () => {
    expect(parse("width:100..200").children[0]).toEqual({
      type: "metatag",
      key: "width",
      op: "range",
      value: "100..200",
    });
  });

  it("does not treat a URL value (with ..) as a range", () => {
    expect(parse("source:https://example.com/a..b").children[0]).toEqual({
      type: "metatag",
      key: "source",
      op: "eq",
      value: "https://example.com/a..b",
    });
  });

  it("lets an operator win over a range-looking value", () => {
    expect(parse("score:>10..20").children[0]).toEqual({
      type: "metatag",
      key: "score",
      op: "gt",
      value: "10..20",
    });
  });

  it("combines tags, OR, NOT and metatags (OR group appended last)", () => {
    expect(parse("1girl ~blue_eyes ~green_eyes -monochrome rating:safe")).toEqual({
      type: "and",
      children: [
        { type: "tag", name: "1girl" },
        { type: "not", child: { type: "tag", name: "monochrome" } },
        { type: "metatag", key: "rating", op: "eq", value: "safe" },
        {
          type: "or",
          children: [
            { type: "tag", name: "blue_eyes" },
            { type: "tag", name: "green_eyes" },
          ],
        },
      ],
    });
  });
});
