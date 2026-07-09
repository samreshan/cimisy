import type { Content } from "mdast";
import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface BlockNode {
  type: string;
  id: string;
  props: Record<string, unknown>;
}

/**
 * A block type's full contract: schema, and how it round-trips to/from
 * MDX. Implementations live in src/mdx/block-registry.ts (kept out of
 * this file so the config layer doesn't need the mdast/remark toolchain
 * as more than a type-only dependency) — this interface is the shared
 * contract between the config API and the MDX read/write pipeline.
 */
export interface BlockDefinition<Props = Record<string, unknown>> {
  readonly kind: string;
  /** `.strict()` zod object schema — unrecognized properties are rejected, not silently dropped. */
  readonly propsSchema: z.ZodType<Props>;
  /**
   * Set only for blocks that serialize as a custom JSX element (e.g.
   * "Image", "Callout"); native markdown blocks (paragraph/heading/code)
   * leave this undefined. The AST allowlist validator (src/mdx) uses this
   * to build its set of permitted JSX tag names — nothing else is ever
   * treated as safe to keep.
   */
  readonly jsxName?: string;
  /**
   * Plain-data hints for the admin UI (e.g. allowed heading levels/code
   * languages/callout tones) — never functions or schemas, so this is
   * safe to send straight to the client as part of the admin manifest.
   */
  readonly uiOptions?: Record<string, unknown>;
  /** Builds this block's mdast node from already-validated props. Never string-concatenates into MDX source. */
  toMdxNode(props: Props): Content;
  /** True if a (validator-approved) mdast node represents this block kind. */
  matches(node: Content): boolean;
  /** Extracts raw (not-yet-validated) props from a matched node; the caller re-validates via propsSchema. */
  extractProps(node: Content): unknown;
}

export interface BlocksFieldOptions {
  label?: string;
  blocks: Record<string, BlockDefinition>;
}

export interface BlocksFieldDefinition extends FieldDefinition<BlockNode[]> {
  readonly kind: "blocks";
  readonly registry: Record<string, BlockDefinition>;
}

export function blocksField(options: BlocksFieldOptions): BlocksFieldDefinition {
  const nodeSchema = z.object({
    type: z.string(),
    id: z.string(),
    props: z.record(z.unknown()),
  });
  return {
    kind: "blocks",
    label: options.label ?? "Content",
    location: "body",
    zodSchema: z.array(nodeSchema),
    registry: options.blocks,
  };
}
