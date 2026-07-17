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
    const { parsed } = roundTrip(
      [{ type: "paragraph", id: "1", props: { content: [{ type: "text", text: "Hello, world." }] } }],
      registry,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.props).toEqual({ content: [{ type: "text", text: "Hello, world." }] });
  });

  it("paragraph: bold/italic/inline-code/link inline formatting survives serialize -> parse (rich text)", () => {
    const registry = { paragraph: paragraph() };
    const content = [
      { type: "text", text: "Say " },
      { type: "strong", children: [{ type: "text", text: "hello" }] },
      { type: "text", text: " to " },
      { type: "emphasis", children: [{ type: "text", text: "the" }] },
      { type: "text", text: " " },
      { type: "inlineCode", code: "world" },
      { type: "text", text: " via a " },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "link" }] },
      { type: "text", text: "." },
    ];
    const { parsed } = roundTrip([{ type: "paragraph", id: "1", props: { content } }], registry);
    expect(parsed[0]?.props).toEqual({ content });
  });

  it("paragraph: a nested mark (bold containing italic containing a link) round-trips exactly", () => {
    const registry = { paragraph: paragraph() };
    const content = [
      {
        type: "strong",
        children: [
          {
            type: "emphasis",
            children: [{ type: "link", href: "https://example.com/x", children: [{ type: "text", text: "deep" }] }],
          },
        ],
      },
    ];
    const { parsed } = roundTrip([{ type: "paragraph", id: "1", props: { content } }], registry);
    expect(parsed[0]?.props).toEqual({ content });
  });

  it("paragraph: an old v1 { text } payload is upgraded to { content } on write (back-compat shim)", () => {
    const registry = { paragraph: paragraph() };
    const mdx = serializeBlocksToMdx([{ type: "paragraph", id: "1", props: { text: "legacy" } as never }], registry);
    const parsed = parseMdxToBlocks(mdx, registry);
    expect(parsed[0]?.props).toEqual({ content: [{ type: "text", text: "legacy" }] });
  });

  it("paragraph: rejects a javascript: link URL even when hand-constructed as props (defense in depth, schema layer)", () => {
    const registry = { paragraph: paragraph() };
    const content = [{ type: "link", href: "javascript:alert(1)", children: [{ type: "text", text: "x" }] }];
    expect(() => serializeBlocksToMdx([{ type: "paragraph", id: "1", props: { content } }], registry)).toThrow();
  });

  it("paragraph: inline node kinds outside the supported set (e.g. a hard line break) from hand-edited MDX are flattened to text, not rejected", () => {
    const registry = { paragraph: paragraph() };
    const parsed = parseMdxToBlocks("First line\\\nSecond line", registry);
    expect(parsed[0]?.props).toEqual({
      content: [{ type: "text", text: "First line" }, { type: "text", text: "" }, { type: "text", text: "Second line" }],
    });
  });

  it("heading: level and content survive round-trip", () => {
    const registry = { heading: heading() };
    const content = [{ type: "text", text: "Section Title" }];
    const { parsed } = roundTrip([{ type: "heading", id: "1", props: { level: 3, content } }], registry);
    expect(parsed[0]?.props).toEqual({ level: 3, content });
  });

  it("heading: bold/italic/link inline formatting survives serialize -> parse (rich text)", () => {
    const registry = { heading: heading() };
    const content = [
      { type: "text", text: "A " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://example.com/", children: [{ type: "emphasis", children: [{ type: "text", text: "link" }] }] },
    ];
    const { parsed } = roundTrip([{ type: "heading", id: "1", props: { level: 2, content } }], registry);
    expect(parsed[0]?.props).toEqual({ level: 2, content });
  });

  it("heading: an old 2.3 { level, text } payload is upgraded to { level, content } on write (back-compat shim)", () => {
    const registry = { heading: heading() };
    const { parsed } = roundTrip([{ type: "heading", id: "1", props: { level: 3, text: "Legacy" } }], registry);
    expect(parsed[0]?.props).toEqual({ level: 3, content: [{ type: "text", text: "Legacy" }] });
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

  it("callout: tone and content survive round-trip", () => {
    const registry = { callout: callout({ tones: ["info", "warning"] }) };
    const { parsed } = roundTrip(
      [{ type: "callout", id: "1", props: { tone: "warning", content: [{ type: "text", text: "Heads up." }] } }],
      registry,
    );
    expect(parsed[0]?.props).toEqual({ tone: "warning", content: [{ type: "text", text: "Heads up." }] });
  });

  it("callout: an old v1 { tone, text } payload is upgraded to { tone, content } on write (back-compat shim)", () => {
    const registry = { callout: callout({ tones: ["info"] }) };
    const mdx = serializeBlocksToMdx([{ type: "callout", id: "1", props: { tone: "info", text: "legacy" } as never }], registry);
    const parsed = parseMdxToBlocks(mdx, registry);
    expect(parsed[0]?.props).toEqual({ tone: "info", content: [{ type: "text", text: "legacy" }] });
  });

  it("callout: rejects a tone outside the configured allowlist", () => {
    const registry = { callout: callout({ tones: ["info"] }) };
    expect(() =>
      serializeBlocksToMdx(
        [{ type: "callout", id: "1", props: { tone: "danger", content: [{ type: "text", text: "x" }] } }],
        registry,
      ),
    ).toThrow();
  });

  it("rejects unknown props on a block via the .strict() schema (extra/unexpected properties, not just missing ones)", () => {
    const registry = { paragraph: paragraph() };
    expect(() =>
      serializeBlocksToMdx(
        [{ type: "paragraph", id: "1", props: { content: [{ type: "text", text: "hi" }], extraProp: "should not be allowed" } }],
        registry,
      ),
    ).toThrow();
  });

  it("multiple blocks of mixed types preserve order through a full round-trip", () => {
    const registry = { paragraph: paragraph(), heading: heading(), image: image() };
    const blocks = [
      { type: "heading", id: "1", props: { level: 1, text: "Title" } },
      { type: "paragraph", id: "2", props: { content: [{ type: "text", text: "Intro." }] } },
      { type: "image", id: "3", props: { src: "/a.png", alt: "a" } },
      { type: "paragraph", id: "4", props: { content: [{ type: "text", text: "Outro." }] } },
    ];
    const { parsed } = roundTrip(blocks, registry);
    expect(parsed.map((b) => b.type)).toEqual(["heading", "paragraph", "image", "paragraph"]);
  });

  it("serialize never string-interpolates props into MDX source: quotes/braces in text can't break out of the block", () => {
    const registry = { paragraph: paragraph(), callout: callout({ tones: ["info"] }) };
    const dangerousText = '</Callout><script>alert(1)</script><Callout tone="info">';
    const mdx = serializeBlocksToMdx(
      [{ type: "callout", id: "1", props: { tone: "info", content: [{ type: "text", text: dangerousText }] } }],
      registry,
    );
    // The dangerous text must appear as inert text content, not re-open a new element.
    const parsed = parseMdxToBlocks(mdx, registry);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.props).toEqual({ tone: "info", content: [{ type: "text", text: dangerousText }] });
  });
});
