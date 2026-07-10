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
import { type InlineNode, inlineContentSchema, inlineFromMdast, inlineToMdast } from "./inline.js";

function textNode(value: string): Content {
  return { type: "text", value } as Content;
}

/**
 * Accepts the v1 `{ text: string }` shape and upgrades it to the v2
 * `{ content: InlineNode[] }` shape before the real schema runs. On-disk
 * v1 files need no migration at all — parse.ts always rebuilds `content`
 * fresh from mdast, so this shim exists purely for in-flight v1 clients
 * (e.g. a browser tab open across a deploy) whose last unsaved edit is
 * still in the old shape.
 */
function upgradeLegacyText(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string" && !("content" in obj)) {
      const { text, ...rest } = obj;
      return { ...rest, content: [{ type: "text", text } satisfies InlineNode] };
    }
  }
  return value;
}

/**
 * Standard markdown paragraph, no JSX. Inline formatting (bold/italic/
 * inline-code/links) is a first-class `content: InlineNode[]` prop as of
 * v2 — see mdx/inline.ts. Any *other* inline markdown a hand-editor might
 * add (strikethrough, footnotes, hard breaks, ...) still flattens to
 * plain text rather than being rejected: it's 100% inert markdown with
 * zero code-execution surface, so the fail-closed posture that applies to
 * JSX/expressions doesn't apply here — a data-fidelity choice, not a
 * safety one.
 */
export function paragraph(): BlockDefinition<{ content: InlineNode[] }> {
  return {
    kind: "paragraph",
    propsSchema: z.preprocess(upgradeLegacyText, z.object({ content: inlineContentSchema }).strict()) as unknown as z.ZodType<{
      content: InlineNode[];
    }>,
    richTextProp: "content",
    toMdxNode: ({ content }) => ({ type: "paragraph", children: inlineToMdast(content) }) as Content,
    matches: (node) => node.type === "paragraph",
    extractProps: (node) => ({
      content: inlineFromMdast(("children" in node ? (node as unknown as { children: unknown[] }).children : []) as never),
    }),
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

export function callout(options: CalloutOptions): BlockDefinition<{ tone: string; content: InlineNode[] }> {
  const allowedTones = options.tones;
  return {
    kind: "callout",
    propsSchema: z.preprocess(
      upgradeLegacyText,
      z
        .object({
          tone: z.string().refine((t) => allowedTones.includes(t), { message: `Tone must be one of: ${allowedTones.join(", ")}` }),
          content: inlineContentSchema,
        })
        .strict(),
    ) as unknown as z.ZodType<{ tone: string; content: InlineNode[] }>,
    jsxName: "Callout",
    uiOptions: { tones: allowedTones },
    richTextProp: "content",
    toMdxNode: ({ tone, content }) =>
      ({
        type: "mdxJsxFlowElement",
        name: "Callout",
        attributes: [{ type: "mdxJsxAttribute", name: "tone", value: tone }],
        children: [{ type: "paragraph", children: inlineToMdast(content) }],
      }) as Content,
    matches: (node) => node.type === "mdxJsxFlowElement" && (node as unknown as { name: string | null }).name === "Callout",
    extractProps: (node) => {
      const children = "children" in node ? (node as unknown as { children: Content[] }).children : [];
      const firstParagraph = children.find((c) => c.type === "paragraph") as unknown as { children?: unknown[] } | undefined;
      return {
        ...extractJsxAttributes(node),
        content: inlineFromMdast((firstParagraph?.children ?? []) as never),
      };
    },
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
