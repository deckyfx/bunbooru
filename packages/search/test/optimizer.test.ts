import { describe, expect, it } from "bun:test";

import type { QueryNode } from "../src/ast";
import { collectTagNames, optimize } from "../src/optimizer";
import { parse } from "../src/parser";

const tag = (name: string): QueryNode => ({ type: "tag", name });
const aliases = new Map([
  ["kitty", "cat"],
  ["doggo", "dog"],
]);

describe("optimize: alias resolution", () => {
  it("rewrites an aliased tag to its consequent", () => {
    expect(optimize(parse("kitty"), { aliases })).toEqual(tag("cat"));
  });

  it("leaves tags without an alias untouched", () => {
    expect(optimize(parse("kitty solo"), { aliases })).toEqual({
      type: "and",
      children: [tag("cat"), tag("solo")],
    });
  });

  it("rewrites inside NOT and OR", () => {
    expect(optimize(parse("-kitty ~doggo ~bird"), { aliases })).toEqual({
      type: "and",
      children: [
        { type: "not", child: tag("cat") },
        { type: "or", children: [tag("dog"), tag("bird")] },
      ],
    });
  });

  it("never rewrites a wildcard pattern (it matches names, not one tag)", () => {
    expect(optimize(parse("kitty*"), { aliases })).toEqual(tag("kitty*"));
  });

  it("leaves metatags alone", () => {
    const node: QueryNode = { type: "metatag", key: "rating", op: "eq", value: "kitty" };
    expect(optimize(node, { aliases })).toEqual(node);
  });

  it("does not mutate the input tree", () => {
    const input = parse("kitty");
    const snapshot = structuredClone(input);
    optimize(input, { aliases });
    expect(input).toEqual(snapshot);
  });
});

describe("optimize: simplification", () => {
  it("collapses a single-child AND to the child", () => {
    expect(optimize(parse("solo"))).toEqual(tag("solo"));
  });

  it("keeps an empty AND (it means: match everything)", () => {
    expect(optimize(parse(""))).toEqual({ type: "and", children: [] });
  });

  it("drops duplicate terms, keeping first-seen order", () => {
    expect(optimize(parse("solo cat solo"))).toEqual({
      type: "and",
      children: [tag("solo"), tag("cat")],
    });
  });

  it("drops a term that only became a duplicate after alias resolution", () => {
    expect(optimize(parse("kitty cat"), { aliases })).toEqual(tag("cat"));
  });

  it("dedupes inside an OR group too", () => {
    expect(optimize(parse("~kitty ~cat ~dog"), { aliases })).toEqual({
      type: "or",
      children: [tag("cat"), tag("dog")],
    });
  });

  it("flattens nested groups of the same kind", () => {
    const nested: QueryNode = {
      type: "and",
      children: [tag("a"), { type: "and", children: [tag("b"), { type: "and", children: [tag("c")] }] }],
    };
    expect(optimize(nested)).toEqual({ type: "and", children: [tag("a"), tag("b"), tag("c")] });
  });

  it("does not flatten an OR into an AND", () => {
    const mixed: QueryNode = {
      type: "and",
      children: [tag("a"), { type: "or", children: [tag("b"), tag("c")] }],
    };
    expect(optimize(mixed)).toEqual(mixed);
  });

  it("cancels a double negation", () => {
    const node: QueryNode = { type: "not", child: { type: "not", child: tag("a") } };
    expect(optimize(node)).toEqual(tag("a"));
  });
});

describe("collectTagNames", () => {
  it("returns each exact tag name once, across AND, OR and NOT", () => {
    expect(collectTagNames(parse("a -b ~c ~a b"))).toEqual(["a", "b", "c"]);
  });

  it("skips wildcard patterns and metatags", () => {
    expect(collectTagNames(parse("a* rating:safe b"))).toEqual(["b"]);
  });

  it("is empty for an empty query", () => {
    expect(collectTagNames(parse(""))).toEqual([]);
  });
});
