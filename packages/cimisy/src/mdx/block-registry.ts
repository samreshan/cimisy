import type { Content } from "mdast";
// Imported for its `declare module "mdast"` augmentation (adds
// mdxJsxFlowElement/etc. to mdast's node-type unions) — needed here
// independently of ast-allowlist.ts/parse.ts because tsup's per-file
// declaration generation doesn't pick up type augmentations transitively
// from sibling files the way a whole-program `tsc` build does.
import "mdast-util-mdx";
import { toString as mdastToString } from "mdast-util-to-string";
import { z } from "zod";
import type { BlockDefinition } from "../config/fields/blocks.js";

function textNode(value: string): Content {
  return { type: "text", value } as Content;
}

/**
 * Plain-text paragraph — standard markdown, no JSX. Any inline formatting
 * a hand-editor adds (bold, links, etc.) is flattened to plain text on
 * read rather than rejected: it's 100% inert markdown with zero
 * code-execution surface, so the security fail-closed posture that
 * applies to JSX/expressions doesn't apply here — this is a data-fidelity
 * simplification, not a safety compromise, and is called out in the docs
 * as a known v1 limitation.
 */
export function paragraph(): BlockDefinition<{ text: string }> {
  return {
    kind: "paragraph",
    propsSchema: z.object({ text: z.string() }).strict(),
    toMdxNode: ({ text }) => ({ type: "paragraph", children: [textNode(text)] }) as Content,
    matches: (node) => node.type === "paragraph",
    extractProps: (node) => ({ text: mdastToString(node) }),
  };
}

export interface HeadingOptions {
  levels?: Array<1 | 2 | 3 | 4 | 5 | 6>;
}

export function heading(options: HeadingOptions = {}): BlockDefinition<{ level: 1 | 2 | 3 | 4 | 5 | 6; text: string }> {
  const allowedLevels: number[] = options.levels ?? [1, 2, 3, 4, 5, 6];
  return {
    kind: "heading",
    propsSchema: z
      .object({
        level: z
          .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
          .refine((l) => allowedLevels.includes(l), { message: `Heading level must be one of: ${allowedLevels.join(", ")}` }),
        text: z.string(),
      })
      .strict(),
    uiOptions: { levels: allowedLevels },
    toMdxNode: ({ level, text }) => ({ type: "heading", depth: level, children: [textNode(text)] }) as Content,
    matches: (node) => node.type === "heading",
    extractProps: (node) => {
      const depth = "depth" in node ? (node as { depth: unknown }).depth : undefined;
      return { level: depth, text: mdastToString(node) };
    },
  };
}

export interface CodeOptions {
  languages?: string[];
}

/**
 * Fenced code blocks are native, inert markdown (```lang ... ```) — no
 * JSX wrapper needed, and the content inside is never interpreted as
 * MDX/JS by the parser (it's a literal string value on the node), so
 * there's no injection surface here regardless of what the code contains.
 */
export function code(options: CodeOptions = {}): BlockDefinition<{ code: string; language?: string }> {
  const allowedLanguages = options.languages;
  return {
    kind: "code",
    propsSchema: z
      .object({
        code: z.string(),
        language: z
          .string()
          .refine((l) => !allowedLanguages || allowedLanguages.includes(l), {
            message: allowedLanguages ? `Language must be one of: ${allowedLanguages.join(", ")}` : "Invalid language",
          })
          .optional(),
      })
      .strict(),
    uiOptions: { languages: allowedLanguages },
    toMdxNode: ({ code: value, language }) => ({ type: "code", lang: language ?? null, value }) as Content,
    matches: (node) => node.type === "code",
    extractProps: (node) => {
      const n = node as unknown as { lang?: string | null; value: string };
      return { code: n.value, language: n.lang ?? undefined };
    },
  };
}

export interface ImageOptions {
  /** Repo-relative directory new uploads are written under (upload UI ships in a later milestone). */
  directory?: string;
}

/**
 * The first block type that genuinely needs JSX: it maps to a specific
 * React component (e.g. next/image) on the consuming site, not just
 * formatted text. Constructed as real mdast JSX attribute nodes with
 * literal string values — never string-interpolated into MDX source —
 * which is what rules out attribute-breakout injection at the source.
 */
export function image(options: ImageOptions = {}): BlockDefinition<{ src: string; alt: string }> {
  void options;
  return {
    kind: "image",
    propsSchema: z.object({ src: z.string(), alt: z.string() }).strict(),
    jsxName: "Image",
    toMdxNode: ({ src, alt }) =>
      ({
        type: "mdxJsxFlowElement",
        name: "Image",
        attributes: [
          { type: "mdxJsxAttribute", name: "src", value: src },
          { type: "mdxJsxAttribute", name: "alt", value: alt },
        ],
        children: [],
      }) as Content,
    matches: (node) => node.type === "mdxJsxFlowElement" && (node as unknown as { name: string | null }).name === "Image",
    extractProps: (node) => extractJsxAttributes(node),
  };
}

export interface CalloutOptions {
  tones: string[];
}

export function callout(options: CalloutOptions): BlockDefinition<{ tone: string; text: string }> {
  const allowedTones = options.tones;
  return {
    kind: "callout",
    propsSchema: z
      .object({
        tone: z.string().refine((t) => allowedTones.includes(t), { message: `Tone must be one of: ${allowedTones.join(", ")}` }),
        text: z.string(),
      })
      .strict(),
    jsxName: "Callout",
    uiOptions: { tones: allowedTones },
    toMdxNode: ({ tone, text }) =>
      ({
        type: "mdxJsxFlowElement",
        name: "Callout",
        attributes: [{ type: "mdxJsxAttribute", name: "tone", value: tone }],
        children: [{ type: "paragraph", children: [textNode(text)] }],
      }) as Content,
    matches: (node) => node.type === "mdxJsxFlowElement" && (node as unknown as { name: string | null }).name === "Callout",
    extractProps: (node) => ({
      ...extractJsxAttributes(node),
      text: "children" in node ? mdastToString(node as Content) : "",
    }),
  };
}

/** Reads plain string attributes off a (validator-approved) JSX node into a raw props object. */
function extractJsxAttributes(node: Content): Record<string, unknown> {
  const attributes = "attributes" in node ? (node as unknown as { attributes: Array<{ type: string; name: string; value?: unknown }> }).attributes : [];
  const props: Record<string, unknown> = {};
  for (const attr of attributes) {
    if (attr.type === "mdxJsxAttribute") props[attr.name] = attr.value ?? "";
  }
  return props;
}

export const blockTypes = { paragraph, heading, code, image, callout };
