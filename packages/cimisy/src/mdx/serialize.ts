import type { Content, Root } from "mdast";
import { mdxToMarkdown } from "mdast-util-mdx";
import { toMarkdown } from "mdast-util-to-markdown";
import type { BlockDefinition, BlockNode } from "../config/fields/blocks.js";
import { CimisyError } from "../shared/errors.js";

/**
 * Block tree -> MDX text. Every node is built by the block's own
 * toMdxNode(validatedProps) — never by concatenating strings into MDX
 * source — so there is no attribute-breakout or injection surface on the
 * write path by construction; propsSchema.parse() here is what "validated
 * props" means (throws on anything a block didn't declare/allow).
 */
export function serializeBlocksToMdx(blocks: BlockNode[], registry: Record<string, BlockDefinition>): string {
  const children: Content[] = blocks.map((block) => {
    const def = registry[block.type];
    if (!def) throw new CimisyError(`Unknown block type "${block.type}".`, "UNKNOWN_BLOCK_TYPE");
    const validatedProps = def.propsSchema.parse(block.props);
    return def.toMdxNode(validatedProps);
  });
  const tree: Root = { type: "root", children };
  // emphasis: "_" (strong stays the "**" default): without this, both
  // marks serialize with the same "*" character, so a strong span
  // wrapping (or wrapped by) an emphasis span collapses into the
  // ambiguous "***text***" form — CommonMark always re-parses that as
  // emphasis(strong(text)), silently flipping the nesting order on
  // round-trip regardless of which was originally outermost. Using a
  // different marker per mark keeps every combination (`**_x_**`,
  // `_**x**_`) unambiguous to reparse.
  return toMarkdown(tree, { extensions: [mdxToMarkdown()], emphasis: "_" });
}
