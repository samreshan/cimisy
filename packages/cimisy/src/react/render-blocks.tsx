import { createElement } from "react";
import type { ComponentType, JSX, ReactNode } from "react";

export interface BlockNodeLike {
  type: string;
  id: string;
  props: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BlockComponents = Record<string, ComponentType<any>>;

function Paragraph({ text }: { text: string }) {
  return createElement("p", null, text);
}

function Heading({ level, text }: { level: number; text: string }) {
  const tag = `h${Math.min(Math.max(Math.trunc(level), 1), 6)}` as keyof JSX.IntrinsicElements;
  return createElement(tag, null, text);
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

function Callout({ tone, text }: { tone: string; text: string }) {
  return createElement("div", { "data-cimisy-callout": tone }, text);
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
