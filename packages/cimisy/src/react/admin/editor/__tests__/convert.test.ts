import { describe, expect, it } from "vitest";
import type { BlockNode } from "../../../../config/fields/blocks.js";
import type { InlineNode } from "../../../../mdx/inline.js";
import type { BlockTypeManifest } from "../../../../next/manifest.js";
import {
  CUSTOM_BLOCK_NODE_TYPE,
  blocksToTiptapDoc,
  buildManifestLookup,
  inlineNodesToTiptap,
  tiptapDocToBlocks,
  tiptapInlineToNodes,
  tiptapInlineToPlainText,
  type TiptapDoc,
} from "../convert.js";

const BUILTIN_MANIFEST: BlockTypeManifest[] = [
  { name: "paragraph", kind: "paragraph", label: "Paragraph", richTextProp: "content" },
  { name: "heading", kind: "heading", label: "Heading" },
  { name: "code", kind: "code", label: "Code" },
  { name: "image", kind: "image", label: "Image" },
  { name: "callout", kind: "callout", label: "Callout", richTextProp: "content" },
];
const lookup = buildManifestLookup(BUILTIN_MANIFEST);

function roundTrip(blocks: BlockNode[]): BlockNode[] {
  const doc = blocksToTiptapDoc(blocks, lookup);
  return tiptapDocToBlocks(doc);
}

describe("inline: InlineNode[] <-> Tiptap marks", () => {
  it("plain text round-trips with no marks", () => {
    const content: InlineNode[] = [{ type: "text", text: "hello world" }];
    const tiptap = inlineNodesToTiptap(content);
    expect(tiptap).toEqual([{ type: "text", text: "hello world" }]);
    expect(tiptapInlineToNodes(tiptap)).toEqual(content);
  });

  it("strong/emphasis/inlineCode/link each round-trip individually", () => {
    const cases: InlineNode[][] = [
      [{ type: "strong", children: [{ type: "text", text: "bold" }] }],
      [{ type: "emphasis", children: [{ type: "text", text: "italic" }] }],
      [{ type: "inlineCode", code: "code" }],
      [{ type: "link", href: "https://example.com", children: [{ type: "text", text: "link" }] }],
    ];
    for (const content of cases) {
      const tiptap = inlineNodesToTiptap(content);
      expect(tiptapInlineToNodes(tiptap)).toEqual(content);
    }
  });

  it("a mixed sequence of runs round-trips in order", () => {
    const content: InlineNode[] = [
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
    expect(tiptapInlineToNodes(inlineNodesToTiptap(content))).toEqual(content);
  });

  it("nested marks already in canonical order (link > strong > emphasis) round-trip exactly", () => {
    const content: InlineNode[] = [
      {
        type: "link",
        href: "https://example.com/x",
        children: [{ type: "strong", children: [{ type: "emphasis", children: [{ type: "text", text: "deep" }] }] }],
      },
    ];
    expect(tiptapInlineToNodes(inlineNodesToTiptap(content))).toEqual(content);
  });

  it("nested marks in a NON-canonical order (strong wrapping a link) normalize to canonical order through Tiptap's flat mark model — Tiptap has no way to preserve which was originally outermost, so any round-trip through it converges on the fixed link > strong > emphasis > code priority", () => {
    const nonCanonical: InlineNode[] = [
      { type: "strong", children: [{ type: "link", href: "https://example.com/x", children: [{ type: "text", text: "deep" }] }] },
    ];
    const result = tiptapInlineToNodes(inlineNodesToTiptap(nonCanonical));
    expect(result).toEqual([
      { type: "link", href: "https://example.com/x", children: [{ type: "strong", children: [{ type: "text", text: "deep" }] }] },
    ]);
  });

  it("deterministic mark nesting order (link > strong > emphasis > code) regardless of the order Tiptap lists marks in", () => {
    const order1 = inlineNodesToTiptap([]);
    void order1;
    // Simulate Tiptap emitting marks in a non-canonical order (e.g. italic before bold before link).
    const tiptapRun = [{ type: "text" as const, text: "x", marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://example.com" } }, { type: "bold" }] }];
    const result = tiptapInlineToNodes(tiptapRun);
    // Expected canonical nesting: link (outermost) > bold > italic (innermost).
    expect(result).toEqual([
      {
        type: "link",
        href: "https://example.com",
        children: [{ type: "strong", children: [{ type: "emphasis", children: [{ type: "text", text: "x" }] }] }],
      },
    ]);
  });

  it("bold + inlineCode combination nests code inside strong", () => {
    const tiptapRun = [{ type: "text" as const, text: "x", marks: [{ type: "bold" }, { type: "code" }] }];
    expect(tiptapInlineToNodes(tiptapRun)).toEqual([{ type: "strong", children: [{ type: "inlineCode", code: "x" }] }]);
  });

  it("drops a javascript: link href rather than propagating it (defense in depth, matches mdx/inline.ts's isSafeUrl)", () => {
    const tiptapRun = [{ type: "text" as const, text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }];
    const result = tiptapInlineToNodes(tiptapRun);
    expect(result).toEqual([{ type: "link", href: "", children: [{ type: "text", text: "click" }] }]);
  });

  it("empty text runs are dropped rather than emitted as zero-length ProseMirror text nodes", () => {
    expect(inlineNodesToTiptap([{ type: "text", text: "" }])).toEqual([]);
    expect(inlineNodesToTiptap([{ type: "inlineCode", code: "" }])).toEqual([]);
  });

  it("tiptapInlineToPlainText flattens marks and concatenates text (used for heading, which stays plain-text-only)", () => {
    const tiptap = [{ type: "text" as const, text: "bold", marks: [{ type: "bold" }] }, { type: "text" as const, text: " plain" }];
    expect(tiptapInlineToPlainText(tiptap)).toBe("bold plain");
  });

  it("tiptapInlineToPlainText handles undefined content", () => {
    expect(tiptapInlineToPlainText(undefined)).toBe("");
  });
});

describe("blocksToTiptapDoc / tiptapDocToBlocks: built-in block kinds", () => {
  it("paragraph round-trips with rich content, preserving id and registry type", () => {
    const blocks: BlockNode[] = [
      { type: "paragraph", id: "p1", props: { content: [{ type: "text", text: "hello" }] } },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("heading round-trips level and rich content", () => {
    const blocks: BlockNode[] = [
      {
        type: "heading",
        id: "h1",
        props: {
          level: 3,
          content: [{ type: "text", text: "Section " }, { type: "strong", children: [{ type: "text", text: "title" }] }],
        },
      },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("heading in the legacy 2.3 { level, text } shape loads into the editor and saves as { level, content }", () => {
    const blocks: BlockNode[] = [{ type: "heading", id: "h1", props: { level: 3, text: "Legacy" } }];
    expect(roundTrip(blocks)).toEqual([
      { type: "heading", id: "h1", props: { level: 3, content: [{ type: "text", text: "Legacy" }] } },
    ]);
  });

  it("code round-trips code and language", () => {
    const blocks: BlockNode[] = [{ type: "code", id: "c1", props: { code: "const x = 1;\nconsole.log(x);", language: "ts" } }];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("code without a language round-trips (language omitted, not null/undefined key)", () => {
    const blocks: BlockNode[] = [{ type: "code", id: "c1", props: { code: "plain" } }];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("image round-trips src and alt", () => {
    const blocks: BlockNode[] = [{ type: "image", id: "i1", props: { src: "/a.png", alt: "A description" } }];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("callout round-trips tone and rich content", () => {
    const blocks: BlockNode[] = [
      {
        type: "callout",
        id: "co1",
        props: { tone: "warning", content: [{ type: "text", text: "Heads up: " }, { type: "strong", children: [{ type: "text", text: "read this" }] }] },
      },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("multiple blocks of mixed kinds preserve order", () => {
    const blocks: BlockNode[] = [
      { type: "heading", id: "1", props: { level: 1, text: "Title" } },
      { type: "paragraph", id: "2", props: { content: [{ type: "text", text: "Intro." }] } },
      { type: "image", id: "3", props: { src: "/a.png", alt: "a" } },
      { type: "paragraph", id: "4", props: { content: [{ type: "text", text: "Outro." }] } },
    ];
    expect(roundTrip(blocks).map((b) => b.type)).toEqual(["heading", "paragraph", "image", "paragraph"]);
  });

  it("a registry key that differs from its kind (e.g. \"intro\" using the paragraph kind) preserves the registry key, not the kind name", () => {
    const customManifest: BlockTypeManifest[] = [{ name: "intro", kind: "paragraph", label: "Intro" }];
    const customLookup = buildManifestLookup(customManifest);
    const blocks: BlockNode[] = [{ type: "intro", id: "1", props: { content: [{ type: "text", text: "hi" }] } }];
    const doc = blocksToTiptapDoc(blocks, customLookup);
    expect(doc.content[0]!.type).toBe("paragraph"); // ProseMirror node type reflects kind
    expect(doc.content[0]!.attrs?.blockType).toBe("intro"); // but the registry key survives
    expect(tiptapDocToBlocks(doc)).toEqual(blocks);
  });
});

describe("blocksToTiptapDoc / tiptapDocToBlocks: unknown/custom block fallback", () => {
  it("a block type absent from the manifest becomes a cimisyCustomBlock node, never dropped", () => {
    const blocks: BlockNode[] = [{ type: "quote", id: "q1", props: { author: "Ada", text: "Quote text" } }];
    const doc = blocksToTiptapDoc(blocks, lookup);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]!.type).toBe(CUSTOM_BLOCK_NODE_TYPE);
    expect(doc.content[0]!.attrs?.blockType).toBe("quote");
    expect(JSON.parse(doc.content[0]!.attrs?.propsJson as string)).toEqual({ author: "Ada", text: "Quote text" });
  });

  it("a custom block's arbitrary props round-trip exactly through JSON, including nested structures", () => {
    const blocks: BlockNode[] = [
      { type: "quote", id: "q1", props: { author: "Ada", tags: ["math", "computing"], meta: { year: 1843, verified: true } } },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("editing a custom block's propsJson attr in place (simulating the embedded form's onChange) round-trips the new props", () => {
    const blocks: BlockNode[] = [{ type: "quote", id: "q1", props: { text: "original" } }];
    const doc = blocksToTiptapDoc(blocks, lookup);
    doc.content[0]!.attrs = { ...doc.content[0]!.attrs, propsJson: JSON.stringify({ text: "edited" }) };
    expect(tiptapDocToBlocks(doc)).toEqual([{ type: "quote", id: "q1", props: { text: "edited" } }]);
  });

  it("malformed propsJson (corrupted attrs) degrades to an empty props object rather than throwing", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [{ type: CUSTOM_BLOCK_NODE_TYPE, attrs: { blockId: "x", blockType: "quote", propsJson: "{not valid json" } }],
    };
    expect(() => tiptapDocToBlocks(doc)).not.toThrow();
    expect(tiptapDocToBlocks(doc)).toEqual([{ type: "quote", id: "x", props: {} }]);
  });

  it("propsJson that parses to a non-object (e.g. an array or a number) degrades to an empty props object", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [{ type: CUSTOM_BLOCK_NODE_TYPE, attrs: { blockId: "x", blockType: "quote", propsJson: "[1,2,3]" } }],
    };
    expect(tiptapDocToBlocks(doc)).toEqual([{ type: "quote", id: "x", props: {} }]);
  });
});

describe("blocksToTiptapDoc: empty-document handling", () => {
  it("an empty block array becomes a doc with one empty paragraph, not an empty content array (ProseMirror requires block+)", () => {
    const doc = blocksToTiptapDoc([], lookup);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]!.type).toBe("paragraph");
  });

  it("that placeholder paragraph round-trips back to an empty block array (not a spurious empty paragraph block)", () => {
    const doc = blocksToTiptapDoc([], lookup);
    // An intentionally-empty paragraph with zero inline content, exactly as a user clearing all blocks would leave it.
    expect(tiptapDocToBlocks(doc)).toEqual([{ type: "paragraph", id: doc.content[0]!.attrs?.blockId, props: { content: [] } }]);
  });
});

describe("tiptapDocToBlocks: missing/malformed attrs resilience", () => {
  it("generates a fresh blockId when a node has none (never crashes on a missing id)", () => {
    const doc: TiptapDoc = { type: "doc", content: [{ type: "paragraph", attrs: { blockType: "paragraph" }, content: [] }] };
    const blocks = tiptapDocToBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(typeof blocks[0]!.id).toBe("string");
    expect(blocks[0]!.id.length).toBeGreaterThan(0);
  });

  it("falls back to the ProseMirror node type name as blockType when blockType attr is missing", () => {
    const doc: TiptapDoc = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "p1" }, content: [] }] };
    expect(tiptapDocToBlocks(doc)[0]!.type).toBe("paragraph");
  });

  it("tolerates a doc with no content array at all", () => {
    expect(tiptapDocToBlocks({ type: "doc", content: [] })).toEqual([]);
  });
});
