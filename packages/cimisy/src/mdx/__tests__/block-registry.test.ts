import { describe, expect, it } from "vitest";
import type { BlockDefinition } from "../../config/fields/blocks.js";
import { callout, code, heading, image, paragraph } from "../block-registry.js";
import { parseMdxToBlocks } from "../parse.js";
import { serializeBlocksToMdx } from "../serialize.js";

function roundTrip(blocks: Array<{ type: string; id: string; props: Record<string, unknown> }>, registry: Record<string, BlockDefinition>) {
  const mdx = serializeBlocksToMdx(blocks, registry);
  const parsed = parseMdxToBlocks(mdx, registry);
  return { mdx, parsed };
}

describe("block registry round-trips", () => {
  it("paragraph: text survives serialize -> parse", () => {
    const registry = { paragraph: paragraph() };
    const { parsed } = roundTrip([{ type: "paragraph", id: "1", props: { text: "Hello, world." } }], registry);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.props).toEqual({ text: "Hello, world." });
  });

  it("paragraph: inline formatting from hand-edited MDX is flattened to plain text, not rejected", () => {
    const registry = { paragraph: paragraph() };
    const parsed = parseMdxToBlocks("This has **bold** and *italic* and a [link](https://example.com).", registry);
    expect(parsed[0]?.props.text).toBe("This has bold and italic and a link.");
  });

  it("heading: level and text survive round-trip", () => {
    const registry = { heading: heading() };
    const { parsed } = roundTrip([{ type: "heading", id: "1", props: { level: 3, text: "Section Title" } }], registry);
    expect(parsed[0]?.props).toEqual({ level: 3, text: "Section Title" });
  });

  it("heading: rejects a level outside the configured allowlist", () => {
    const registry = { heading: heading({ levels: [1, 2] }) };
    expect(() => serializeBlocksToMdx([{ type: "heading", id: "1", props: { level: 4, text: "x" } }], registry)).toThrow();
  });

  it("code: content, language, and internal whitespace survive round-trip", () => {
    const registry = { code: code({ languages: ["ts", "bash"] }) };
    const codeText = "function f() {\n  return 1;\n}";
    const { parsed } = roundTrip([{ type: "code", id: "1", props: { code: codeText, language: "ts" } }], registry);
    expect(parsed[0]?.props).toEqual({ code: codeText, language: "ts" });
  });

  it("code: rejects a language outside the configured allowlist", () => {
    const registry = { code: code({ languages: ["ts"] }) };
    expect(() => serializeBlocksToMdx([{ type: "code", id: "1", props: { code: "x", language: "python" } }], registry)).toThrow();
  });

  it("image: src and alt (including special characters) survive round-trip", () => {
    const registry = { image: image() };
    const { parsed } = roundTrip(
      [{ type: "image", id: "1", props: { src: "/img/a.png", alt: 'A "quoted" & <tricky> value' } }],
      registry,
    );
    expect(parsed[0]?.props).toEqual({ src: "/img/a.png", alt: 'A "quoted" & <tricky> value' });
  });

  it("callout: tone and text survive round-trip", () => {
    const registry = { callout: callout({ tones: ["info", "warning"] }) };
    const { parsed } = roundTrip([{ type: "callout", id: "1", props: { tone: "warning", text: "Heads up." } }], registry);
    expect(parsed[0]?.props).toEqual({ tone: "warning", text: "Heads up." });
  });

  it("callout: rejects a tone outside the configured allowlist", () => {
    const registry = { callout: callout({ tones: ["info"] }) };
    expect(() => serializeBlocksToMdx([{ type: "callout", id: "1", props: { tone: "danger", text: "x" } }], registry)).toThrow();
  });

  it("rejects unknown props on a block via the .strict() schema (extra/unexpected properties, not just missing ones)", () => {
    const registry = { paragraph: paragraph() };
    expect(() =>
      serializeBlocksToMdx([{ type: "paragraph", id: "1", props: { text: "hi", extraProp: "should not be allowed" } }], registry),
    ).toThrow();
  });

  it("multiple blocks of mixed types preserve order through a full round-trip", () => {
    const registry = { paragraph: paragraph(), heading: heading(), image: image() };
    const blocks = [
      { type: "heading", id: "1", props: { level: 1, text: "Title" } },
      { type: "paragraph", id: "2", props: { text: "Intro." } },
      { type: "image", id: "3", props: { src: "/a.png", alt: "a" } },
      { type: "paragraph", id: "4", props: { text: "Outro." } },
    ];
    const { parsed } = roundTrip(blocks, registry);
    expect(parsed.map((b) => b.type)).toEqual(["heading", "paragraph", "image", "paragraph"]);
  });

  it("serialize never string-interpolates props into MDX source: quotes/braces in text can't break out of the block", () => {
    const registry = { paragraph: paragraph(), callout: callout({ tones: ["info"] }) };
    const dangerousText = '</Callout><script>alert(1)</script><Callout tone="info">';
    const mdx = serializeBlocksToMdx([{ type: "callout", id: "1", props: { tone: "info", text: dangerousText } }], registry);
    // The dangerous text must appear as inert text content, not re-open a new element.
    const parsed = parseMdxToBlocks(mdx, registry);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.props.text).toBe(dangerousText);
  });
});
