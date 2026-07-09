import { randomUUID } from "node:crypto";
import type { Root } from "mdast";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { BlockDefinition, BlockNode } from "../config/fields/blocks.js";
import { ValidationError } from "../shared/errors.js";
import { assertSafeMdxTree } from "./ast-allowlist.js";

const processor = unified().use(remarkParse).use(remarkMdx);

/**
 * MDX text -> block tree, with the AST allowlist (assertSafeMdxTree) as a
 * mandatory gate before anything else runs. This is the read path used
 * both by cimisy's own editor and — structurally, once M5 wires up the
 * Reader/render helper — by the consuming site, since the same
 * hand-edited-outside-the-UI risk applies to both.
 */
export function parseMdxToBlocks(source: string, registry: Record<string, BlockDefinition>): BlockNode[] {
  const tree = processor.parse(source) as Root;
  assertSafeMdxTree(tree, registry);

  return tree.children.map((node) => {
    const entry = Object.entries(registry).find(([, def]) => def.matches(node));
    if (!entry) {
      throw new ValidationError(
        `Unrecognized content: a "${node.type}" node doesn't match any registered block type.`,
        null,
      );
    }
    const [blockTypeName, def] = entry;
    const rawProps = def.extractProps(node);
    const result = def.propsSchema.safeParse(rawProps);
    if (!result.success) {
      throw new ValidationError(`Block "${blockTypeName}" failed validation.`, result.error.issues);
    }
    return { type: blockTypeName, id: randomUUID(), props: result.data as Record<string, unknown> };
  });
}
