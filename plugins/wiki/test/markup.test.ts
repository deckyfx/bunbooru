import { describe, expect, it } from "bun:test";

import { excerpt, tokenize, type MarkupToken } from "../src/markup";

const text = (value: string): MarkupToken => ({ type: "text", text: value });
const wiki = (title: string, label = title): MarkupToken => ({ type: "wiki", title, label });
const search = (tag: string, label = tag): MarkupToken => ({ type: "search", tag, label });

describe("tokenize", () => {
  it("is one text token for plain text, and nothing for an empty body", () => {
    expect(tokenize("just text\nover lines")).toEqual([text("just text\nover lines")]);
    expect(tokenize("")).toEqual([]);
  });

  it("finds wiki and search links, normalizing their targets", () => {
    expect(tokenize("See [[Blue Sky]] or {{ blue_sky }}.")).toEqual([
      text("See "),
      wiki("blue_sky", "Blue Sky"),
      text(" or "),
      search("blue_sky"),
      text("."),
    ]);
  });

  it("splits adjacent links with no text between them", () => {
    expect(tokenize("[[a]][[b]]{{c}}{{d}}")).toEqual([wiki("a"), wiki("b"), search("c"), search("d")]);
  });

  it("keeps characters a tag may hold in a target", () => {
    expect(tokenize("[[ac/dc]] {{50%}}")).toEqual([wiki("ac/dc"), text(" "), search("50%")]);
  });

  it("leaves empty, blank or invalid links as literal text", () => {
    expect(tokenize("[[]] {{}} [[  ]] [[a*]]")).toEqual([text("[[]] {{}} [[  ]] [[a*]]")]);
    expect(tokenize(`[[${"a".repeat(101)}]]`)).toEqual([text(`[[${"a".repeat(101)}]]`)]);
  });

  it("leaves unclosed or mismatched brackets as text", () => {
    expect(tokenize("[[open and {{also")).toEqual([text("[[open and {{also")]);
    expect(tokenize("[[mixed}} {{mixed]]")).toEqual([text("[[mixed}} {{mixed]]")]);
    expect(tokenize("a ]] b }} c")).toEqual([text("a ]] b }} c")]);
  });

  it("links only the innermost pair of nested brackets", () => {
    expect(tokenize("[[a [[b]] c]]")).toEqual([text("[[a "), wiki("b"), text(" c]]")]);
    expect(tokenize("[[[x]]]")).toEqual([text("["), wiki("x"), text("]")]);
    expect(tokenize("{{{x}}}")).toEqual([text("{"), search("x"), text("}")]);
    expect(tokenize("[[{{x}}]]")).toEqual([text("[["), search("x"), text("]]")]);
  });

  it("doesn't link across lines", () => {
    expect(tokenize("[[a\nb]]")).toEqual([text("[[a\nb]]")]);
  });

  it("treats HTML as text", () => {
    expect(tokenize("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
  });

  it("is linear on pathological input", () => {
    const body = "[[".repeat(20_000) + "{{".repeat(20_000);
    const started = performance.now();
    expect(tokenize(body)).toEqual([text(body)]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("excerpt", () => {
  it("keeps a short body whole", () => {
    const tokens = tokenize("short [[a]] body");
    expect(excerpt(tokens, 300)).toEqual({ tokens, truncated: false });
  });

  it("cuts long text at a word boundary and marks it", () => {
    const { tokens, truncated } = excerpt(tokenize("one two three four"), 10);
    expect(truncated).toBe(true);
    expect(tokens).toEqual([text("one two…")]);
  });

  it("cuts mid-word when there's no nearby space", () => {
    expect(excerpt(tokenize("abcdefghijkl"), 5).tokens).toEqual([text("abcde…")]);
  });

  it("never splits a link: one that doesn't fit is dropped", () => {
    expect(excerpt(tokenize("ab [[long title here]] c"), 6)).toEqual({
      tokens: [text("ab…")],
      truncated: true,
    });
    expect(excerpt(tokenize("[[long title]]"), 3)).toEqual({ tokens: [text("…")], truncated: true });
  });

  it("counts a link by its label", () => {
    expect(excerpt(tokenize("[[abc]]de"), 5)).toEqual({ tokens: [wiki("abc"), text("de")], truncated: false });
  });
});
