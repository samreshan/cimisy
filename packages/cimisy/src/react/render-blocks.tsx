import { createElement } from "react";
import type { ComponentType, JSX, ReactNode } from "react";
import type { InlineNode } from "../mdx/inline.js";

export interface BlockNodeLike {
  type: string;
  id: string;
  props: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BlockComponents = Record<string, ComponentType<any>>;

/**
 * Renders an already-validated InlineNode[] tree (see mdx/inline.ts). By
 * the time content reaches here it's passed through assertSafeMdxTree +
 * the inline zod schema's isSafeUrl refine, but link hrefs are re-checked
 * here too — the same defense-in-depth posture as the rest of the mdx
 * pipeline, since this function is also reachable with hand-constructed
 * props via a custom `components` map.
 */
function renderInline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return createElement("strong", { key: index }, renderInline(node.children));
      case "emphasis":
        return createElement("em", { key: index }, renderInline(node.children));
      case "inlineCode":
        return createElement("code", { key: index }, node.code);
      case "link":
        return isSafeLinkHref(node.href)
          ? createElement("a", { key: index, href: node.href, rel: "noopener noreferrer" }, renderInline(node.children))
          : createElement("span", { key: index }, renderInline(node.children));
    }
  });
}

function isSafeLinkHref(href: string): boolean {
  return !/^\s*(javascript|vbscript|data):/i.test(href);
}

function Paragraph({ content }: { content: InlineNode[] }) {
  return createElement("p", null, renderInline(content));
}

/** `content` is the current rich shape (2.4+); plain `text` still renders for hand-constructed props in the pre-richification shape. */
function Heading({ level, content, text }: { level: number; content?: InlineNode[]; text?: string }) {
  const tag = `h${Math.min(Math.max(Math.trunc(level), 1), 6)}` as keyof JSX.IntrinsicElements;
  return createElement(tag, null, Array.isArray(content) ? renderInline(content) : (text ?? ""));
}

function Code({ code, language }: { code: string; language?: string }) {
  return createElement("pre", null, createElement("code", { className: language ? `language-${language}` : undefined }, code));
}

// Plain <img>, deliberately: this is the framework-agnostic default.
// Consumers pass their own Image component (e.g. next/image) via the
// `components` map to override it.
function Image({ src, alt }: { src: string; alt: string }) {
  return createElement("img", { src, alt });
}

function Callout({ tone, content }: { tone: string; content: InlineNode[] }) {
  return createElement("div", { "data-cimisy-callout": tone }, renderInline(content));
}

/**
 * Plain, unstyled defaults for the built-in block kinds — enough to
 * render correctly out of the box with zero configuration. Consumers
 * override any of these by passing their own entry in the `components`
 * map (e.g. swap `image` for one backed by next/image).
 */
export const defaultBlockComponents: BlockComponents = {
  paragraph: Paragraph,
  heading: Heading,
  code: Code,
  image: Image,
  callout: Callout,
};

/**
 * Renders an already-validated block tree straight to React elements —
 * no MDX/JS recompilation step, and therefore no new code-execution
 * surface at render time. The safety guarantee comes entirely from the
 * read path (content/codec.ts's parseEntry -> mdx/parse.ts's
 * parseMdxToBlocks -> mdx/ast-allowlist.ts's assertSafeMdxTree): by the
 * time a block reaches this function, it has already been validated
 * against the registry, whether it came from cimisy's own editor or a
 * hand-edited file elsewhere in the repo.
 *
 * Throws on a block type with no matching component rather than silently
 * skipping it — an incomplete `components` map relative to the content's
 * registry is a real integration bug worth surfacing immediately, not a
 * blank spot on the page discovered later.
 */
export function renderBlocks(blocks: BlockNodeLike[], components: BlockComponents = defaultBlockComponents): ReactNode[] {
  return blocks.map((block) => {
    const Component = components[block.type];
    if (!Component) {
      throw new Error(
        `renderBlocks: no component registered for block type "${block.type}". Pass a "components" map covering every block type in your registry.`,
      );
    }
    return createElement(Component, { key: block.id, ...block.props });
  });
}
