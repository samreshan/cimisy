import type { Content, Root } from "mdast";
// Imported for their `declare module "mdast"` augmentations (adds
// mdxjsEsm/mdxFlowExpression/mdxTextExpression/mdxJsxFlowElement/etc. to
// mdast's node-type unions) — not otherwise referenced directly here.
import "mdast-util-mdx";
import type { BlockDefinition } from "../config/fields/blocks.js";
import { ValidationError } from "../shared/errors.js";

type AnyNode = Content | Root;

interface JsxLikeNode {
  type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  name: string | null;
  attributes: Array<{ type: string; name?: string; value?: unknown }>;
  children?: unknown[];
}

function isJsxElement(node: AnyNode): node is AnyNode & JsxLikeNode {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

// Legitimate content — even a block editor's richest reasonable output —
// never nests anywhere close to this deep. Without a limit, a crafted
// document (e.g. thousands of nested blockquotes) blows the call stack
// with an uncaught RangeError instead of a clean, caught ValidationError:
// a real DoS vector found by testing this validator against a
// deep-nesting payload, not a hypothetical.
const MAX_TREE_DEPTH = 200;

/**
 * The single function standing between MDX content and code execution.
 * Runs on every parse — both when cimisy's own editor loads a file to
 * hydrate the block tree, and (via the same code path) whenever content
 * reaches this parser at all, regardless of whether it went through the
 * UI. A repo can always be hand-edited outside cimisy entirely, so this
 * has to be correct on its own, not just trusted because "the UI would
 * never write that."
 *
 * Deny-by-default in two dimensions:
 * 1. Node *kind* — mdxjsEsm (import/export) and mdxFlowExpression/
 *    mdxTextExpression ({...} escape hatches) are rejected outright.
 *    These are MDX's actual code-execution surface; content authored
 *    through cimisy's block editor never needs them.
 * 2. JSX *identity* — a JSX element is only trusted if its tag name is
 *    one a block in the registry declares via `jsxName`, and even then
 *    only if every attribute is a plain literal: spread attributes
 *    ({...props}) and expression-valued attributes (src={expr}) are
 *    rejected too, since those are just as capable of smuggling in
 *    arbitrary JS as a bare expression node.
 */
export function assertSafeMdxTree(tree: Root, registry: Record<string, BlockDefinition>): void {
  const allowedJsxNames = new Set(
    Object.values(registry)
      .map((block) => block.jsxName)
      .filter((name): name is string => Boolean(name)),
  );
  walk(tree, allowedJsxNames, 0);
}

function walk(node: AnyNode, allowedJsxNames: Set<string>, depth: number): void {
  if (depth > MAX_TREE_DEPTH) {
    throw new ValidationError(`Content is nested too deeply (over ${MAX_TREE_DEPTH} levels).`, null);
  }
  if (node.type === "mdxjsEsm") {
    throw new ValidationError("MDX import/export statements are not allowed.", null);
  }
  if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
    throw new ValidationError("MDX expression syntax ({...}) is not allowed.", null);
  }
  if (isJsxElement(node)) {
    if (!node.name || !allowedJsxNames.has(node.name)) {
      throw new ValidationError(`JSX element <${node.name ?? "(fragment)"}> is not a recognized block type.`, null);
    }
    for (const attr of node.attributes) {
      if (attr.type !== "mdxJsxAttribute") {
        throw new ValidationError(`Spread attributes ({...props}) are not allowed on <${node.name}>.`, null);
      }
      if (attr.value !== null && attr.value !== undefined && typeof attr.value === "object") {
        throw new ValidationError(`Attribute "${attr.name}" on <${node.name}> must be a literal, not an expression.`, null);
      }
    }
  }
  if ("children" in node && Array.isArray((node as { children?: unknown }).children)) {
    for (const child of (node as unknown as { children: AnyNode[] }).children) {
      walk(child, allowedJsxNames, depth + 1);
    }
  }
}
