import type { BlockNode } from "../../../config/fields/blocks.js";
import { type InlineNode, isSafeUrl } from "../../../mdx/inline.js";
import type { BlockTypeManifest } from "../../../next/manifest.js";

/**
 * Pure, dependency-free JSON <-> BlockNode[] conversion — no ProseMirror
 * runtime, no DOM, fully unit-testable. This is the module every other
 * editor/* file defers to for the actual data mapping, so the risky part
 * (never silently losing content, never producing an unsafe link) is
 * concentrated in one small, heavily-tested place rather than scattered
 * across Tiptap node/NodeView code.
 */

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
}

export interface TiptapDoc {
  type: "doc";
  content: TiptapNode[];
}

/** ProseMirror node-type name for each built-in cimisy block kind — kept out of nodes.tsx so convert.ts has no Tiptap/React import at all. */
export const NODE_TYPE_FOR_KIND: Record<string, string> = {
  paragraph: "paragraph",
  heading: "heading",
  code: "cimisyCodeBlock",
  image: "cimisyImage",
  callout: "cimisyCallout",
};
export const CUSTOM_BLOCK_NODE_TYPE = "cimisyCustomBlock";

function newBlockId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Inline (marks) <-> InlineNode[]
// ---------------------------------------------------------------------

// Outermost -> innermost. Fixed so a given mark combination always nests
// the same way regardless of the order Tiptap happened to list marks in —
// without this, "bold+italic" and "italic+bold" could round-trip to
// differently-nested (though logically equivalent) trees, which would
// make save-without-editing produce a spurious diff.
const MARK_PRIORITY = ["link", "bold", "italic", "code"];

function markRank(type: string): number {
  const i = MARK_PRIORITY.indexOf(type);
  return i === -1 ? MARK_PRIORITY.length : i;
}

/** InlineNode[] -> Tiptap inline content array. Wrapping marks (strong/emphasis/link) become an accumulated Tiptap `marks` array on the leaf text node they eventually reach — Tiptap has no nested wrapper-node concept for these, only flat marks-per-text-run. */
export function inlineNodesToTiptap(nodes: InlineNode[], activeMarks: TiptapMark[] = []): TiptapNode[] {
  const out: TiptapNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        if (node.text.length === 0) continue;
        out.push({ type: "text", text: node.text, ...(activeMarks.length ? { marks: activeMarks } : {}) });
        break;
      case "inlineCode":
        if (node.code.length === 0) continue;
        out.push({ type: "text", text: node.code, marks: [...activeMarks, { type: "code" }] });
        break;
      case "strong":
        out.push(...inlineNodesToTiptap(node.children, [...activeMarks, { type: "bold" }]));
        break;
      case "emphasis":
        out.push(...inlineNodesToTiptap(node.children, [...activeMarks, { type: "italic" }]));
        break;
      case "link":
        out.push(...inlineNodesToTiptap(node.children, [...activeMarks, { type: "link", attrs: { href: node.href } }]));
        break;
    }
  }
  return out;
}

function tiptapTextRunToInline(text: string, marks: TiptapMark[]): InlineNode {
  const hasCode = marks.some((m) => m.type === "code");
  const wrapMarks = marks.filter((m) => m.type !== "code").sort((a, b) => markRank(a.type) - markRank(b.type));
  let node: InlineNode = hasCode ? { type: "inlineCode", code: text } : { type: "text", text };
  // wrapMarks is outermost -> innermost; wrap from the end (innermost) so
  // the first element (outermost) ends up as the final, outermost wrapper.
  for (let i = wrapMarks.length - 1; i >= 0; i--) {
    const mark = wrapMarks[i]!;
    if (mark.type === "bold") {
      node = { type: "strong", children: [node] };
    } else if (mark.type === "italic") {
      node = { type: "emphasis", children: [node] };
    } else if (mark.type === "link") {
      const rawHref = mark.attrs?.href;
      const href = typeof rawHref === "string" && isSafeUrl(rawHref) ? rawHref : "";
      node = { type: "link", href, children: [node] };
    }
    // Any other/unknown mark type is dropped at this layer rather than
    // wrapping with something meaningless — same "flatten, don't crash"
    // posture as mdx/inline.ts's fallback for unsupported mdast nodes.
  }
  return node;
}

/** Tiptap inline content array -> InlineNode[]. Non-text inline content (e.g. a hard break) is dropped rather than crashing — cimisy's inline model has no representation for it yet; the text on either side is preserved. */
export function tiptapInlineToNodes(content: TiptapNode[] | undefined): InlineNode[] {
  if (!content) return [];
  const out: InlineNode[] = [];
  for (const node of content) {
    if (node.type === "text" && typeof node.text === "string") {
      out.push(tiptapTextRunToInline(node.text, node.marks ?? []));
    }
  }
  return out;
}

/** Flattens Tiptap inline content to plain text, discarding marks — used for heading (which the schema still models as `{level, text: string}`, never richified; see mdx/block-registry.ts). */
export function tiptapInlineToPlainText(content: TiptapNode[] | undefined): string {
  if (!content) return "";
  return content
    .filter((n) => n.type === "text" && typeof n.text === "string")
    .map((n) => n.text)
    .join("");
}

function safeInlineArray(value: unknown): InlineNode[] {
  return Array.isArray(value) ? (value as InlineNode[]) : [];
}

// ---------------------------------------------------------------------
// Block-level: BlockNode[] <-> Tiptap doc
// ---------------------------------------------------------------------

function blockToTiptapNode(block: BlockNode, manifestByName: Map<string, BlockTypeManifest>): TiptapNode {
  const typeDef = manifestByName.get(block.type);
  const kind = typeDef?.kind;
  const base = { blockId: block.id, blockType: block.type };

  if (kind === "paragraph") {
    return { type: "paragraph", attrs: base, content: inlineNodesToTiptap(safeInlineArray(block.props.content)) };
  }
  if (kind === "heading") {
    const level = typeof block.props.level === "number" ? block.props.level : 2;
    const text = typeof block.props.text === "string" ? block.props.text : "";
    return {
      type: "heading",
      attrs: { ...base, level },
      content: text.length ? [{ type: "text", text }] : [],
    };
  }
  if (kind === "code") {
    const code = typeof block.props.code === "string" ? block.props.code : "";
    const language = typeof block.props.language === "string" ? block.props.language : null;
    return {
      type: "cimisyCodeBlock",
      attrs: { ...base, language },
      content: code.length ? [{ type: "text", text: code }] : [],
    };
  }
  if (kind === "image") {
    const src = typeof block.props.src === "string" ? block.props.src : "";
    const alt = typeof block.props.alt === "string" ? block.props.alt : "";
    return { type: "cimisyImage", attrs: { ...base, src, alt } };
  }
  if (kind === "callout") {
    const tone = typeof block.props.tone === "string" ? block.props.tone : "";
    return {
      type: "cimisyCallout",
      attrs: { ...base, tone },
      content: inlineNodesToTiptap(safeInlineArray(block.props.content)),
    };
  }

  // Unknown / custom block kind (or a block type absent from the
  // manifest entirely, e.g. content from a since-changed config) — never
  // dropped, never crashes the editor: it becomes an opaque node carrying
  // its raw props as JSON, edited through the same props-form the
  // pre-Tiptap fallback editor used (see blocks-fallback.tsx / nodes.tsx's
  // CustomBlockView).
  return { type: CUSTOM_BLOCK_NODE_TYPE, attrs: { ...base, propsJson: JSON.stringify(block.props) } };
}

function tiptapNodeToBlock(node: TiptapNode): BlockNode | null {
  const blockId = typeof node.attrs?.blockId === "string" ? node.attrs.blockId : newBlockId();
  const blockType = typeof node.attrs?.blockType === "string" ? node.attrs.blockType : node.type;

  if (node.type === "paragraph") {
    return { type: blockType, id: blockId, props: { content: tiptapInlineToNodes(node.content) } };
  }
  if (node.type === "heading") {
    const level = typeof node.attrs?.level === "number" ? node.attrs.level : 2;
    return { type: blockType, id: blockId, props: { level, text: tiptapInlineToPlainText(node.content) } };
  }
  if (node.type === "cimisyCodeBlock") {
    const language = typeof node.attrs?.language === "string" ? node.attrs.language : undefined;
    const code = (node.content ?? []).map((n) => (typeof n.text === "string" ? n.text : "")).join("");
    return { type: blockType, id: blockId, props: language ? { code, language } : { code } };
  }
  if (node.type === "cimisyImage") {
    const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    return { type: blockType, id: blockId, props: { src, alt } };
  }
  if (node.type === "cimisyCallout") {
    const tone = typeof node.attrs?.tone === "string" ? node.attrs.tone : "";
    return { type: blockType, id: blockId, props: { tone, content: tiptapInlineToNodes(node.content) } };
  }
  if (node.type === CUSTOM_BLOCK_NODE_TYPE) {
    const raw = typeof node.attrs?.propsJson === "string" ? node.attrs.propsJson : "{}";
    let props: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      props = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      props = {};
    }
    return { type: blockType, id: blockId, props };
  }

  // A node type the editor doesn't know how to persist at all (shouldn't
  // happen — every node this editor's schema can produce is handled
  // above) — skip rather than throw, so one bad node can't crash the
  // entire save.
  return null;
}

/** BlockNode[] -> a Tiptap-loadable doc. Always has at least one paragraph — an empty `content: []` array isn't a valid ProseMirror doc (its schema requires `block+`). */
export function blocksToTiptapDoc(blocks: BlockNode[], manifestByName: Map<string, BlockTypeManifest>): TiptapDoc {
  const content = blocks.map((b) => blockToTiptapNode(b, manifestByName));
  if (content.length === 0) {
    content.push({ type: "paragraph", attrs: { blockId: newBlockId(), blockType: "paragraph" }, content: [] });
  }
  return { type: "doc", content };
}

/** Tiptap doc -> BlockNode[], the save-path inverse of blocksToTiptapDoc. */
export function tiptapDocToBlocks(doc: TiptapDoc | TiptapNode): BlockNode[] {
  const content = "content" in doc && Array.isArray(doc.content) ? doc.content : [];
  const blocks: BlockNode[] = [];
  for (const node of content) {
    const block = tiptapNodeToBlock(node);
    if (block) blocks.push(block);
  }
  return blocks;
}

export function buildManifestLookup(blockTypes: BlockTypeManifest[] | undefined): Map<string, BlockTypeManifest> {
  return new Map((blockTypes ?? []).map((t) => [t.name, t]));
}
