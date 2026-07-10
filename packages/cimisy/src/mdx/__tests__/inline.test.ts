import { describe, expect, it } from "vitest";
import { type InlineNode, inlineContentSchema, inlineFromMdast, inlineToMdast, isSafeUrl } from "../inline.js";

describe("isSafeUrl", () => {
  it.each([
    ["https://example.com", true],
    ["http://example.com/path?query=1#frag", true],
    ["mailto:person@example.com", true],
    ["/relative/path", true],
    ["relative/path", true],
    ["#anchor", true],
    ["?query=1", true],
    ["//protocol-relative.example.com/x", true],
  ])("accepts %s", (href, expected) => {
    expect(isSafeUrl(href)).toBe(expected);
  });

  it.each([
    ["javascript:alert(1)", false],
    ["JavaScript:alert(1)", false],
    ["vbscript:msgbox(1)", false],
    ["data:text/html,<script>alert(1)</script>", false],
    ["java	script:alert(1)", false],
    ["java\nscript:alert(1)", false],
    ["", false],
    ["a".repeat(2001), false],
  ])("rejects %s", (href, expected) => {
    expect(isSafeUrl(href)).toBe(expected);
  });

  it("does not treat a colon inside a relative path as a scheme", () => {
    expect(isSafeUrl("posts/2024:review")).toBe(true);
  });
});

describe("inlineContentSchema", () => {
  function nestStrong(depth: number): InlineNode {
    let node: InlineNode = { type: "text", text: "leaf" };
    for (let i = 0; i < depth; i++) {
      node = { type: "strong", children: [node] };
    }
    return node;
  }

  it("accepts content nested up to the configured maximum depth", () => {
    const result = inlineContentSchema.safeParse([nestStrong(19)]);
    expect(result.success).toBe(true);
  });

  it("rejects content nested beyond the maximum depth instead of risking a stack overflow", () => {
    const result = inlineContentSchema.safeParse([nestStrong(25)]);
    expect(result.success).toBe(false);
  });

  it("rejects a link with an unsafe href even when hand-constructed as raw JSON (bypassing MDX parsing entirely)", () => {
    const result = inlineContentSchema.safeParse([
      { type: "link", href: "javascript:alert(1)", children: [{ type: "text", text: "x" }] },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra properties on a node (.strict())", () => {
    const result = inlineContentSchema.safeParse([{ type: "text", text: "x", evil: true }]);
    expect(result.success).toBe(false);
  });

  it("rejects an oversized flat array (width DoS guard)", () => {
    const many = Array.from({ length: 1001 }, () => ({ type: "text", text: "x" }));
    const result = inlineContentSchema.safeParse(many);
    expect(result.success).toBe(false);
  });
});

describe("inlineFromMdast / inlineToMdast", () => {
  it("round-trips text/strong/emphasis/inlineCode/link through the mdast shape", () => {
    const content: InlineNode[] = [
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "emphasis", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "inlineCode", code: "d" },
      { type: "text", text: " " },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "e" }] },
    ];
    const mdastNodes = inlineToMdast(content);
    const roundTripped = inlineFromMdast(mdastNodes as never);
    expect(roundTripped).toEqual(content);
  });

  it("flattens an unsafe link href to empty string rather than propagating it (defense in depth alongside ast-allowlist.ts)", () => {
    const roundTripped = inlineFromMdast([
      { type: "link", url: "javascript:alert(1)", children: [{ type: "text", value: "click" }] },
    ] as never);
    expect(roundTripped).toEqual([{ type: "link", href: "", children: [{ type: "text", text: "click" }] }]);
  });

  it("flattens an unrecognized phrasing node kind to plain text instead of dropping or rejecting it", () => {
    const roundTripped = inlineFromMdast([{ type: "break" }] as never);
    expect(roundTripped).toEqual([{ type: "text", text: "" }]);
  });
});
