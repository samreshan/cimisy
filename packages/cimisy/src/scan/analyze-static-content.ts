import ts from "typescript";
import type { InlineNode } from "../mdx/inline.js";

export type StaticFieldValue =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string; alt: string }
  | { kind: "richParagraph"; inline: InlineNode[] }
  | { kind: "linkPair"; label: string; href: string };

export interface StaticFieldCandidate {
  tag: string;
  value: StaticFieldValue;
  /** Char offsets of the whole JSX element in sourceText, for the later codemod's in-place replacement. */
  nodeStart: number;
  nodeEnd: number;
}

export interface StaticContentCandidate {
  sourceFile: string;
  /** Raw hint (a boundary tag's id/className token, or the enclosing component's name for a fallback region) — Phase B slugifies this into a real key. */
  regionHint: string;
  regionStart: number;
  regionEnd: number;
  fields: StaticFieldCandidate[];
}

export interface UnanalyzableStaticCandidate {
  sourceFile: string;
  regionHint: string;
  reason: string;
  nodeStart: number;
  nodeEnd: number;
}

export interface StaticContentAnalysisResult {
  staticContent: StaticContentCandidate[];
  unanalyzable: UnanalyzableStaticCandidate[];
}

/** Lowercase HTML5 semantic tags only — capitalized tags are separate component files already handled by findJsxSections. Nested boundary tags are absorbed into the outer region, not sub-split (v1 simplification). */
const BOUNDARY_TAGS = new Set(["section", "header", "footer", "article", "aside", "main", "nav"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const PLAIN_TEXT_TAGS = new Set([...HEADING_TAGS, "figcaption", "span"]);
const IMAGE_TAGS = new Set(["img", "Image"]);
const LINK_TAGS = new Set(["a", "Link"]);
const CONTENT_TAGS = new Set([...PLAIN_TEXT_TAGS, "p", "blockquote", ...IMAGE_TAGS, ...LINK_TAGS]);
const REPEAT_METHODS = new Set(["map", "filter", "forEach"]);

export type JsxElementLike = ts.JsxElement | ts.JsxSelfClosingElement;

export function isJsxElementLike(node: ts.Node): node is JsxElementLike {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

export function attributesOf(node: JsxElementLike): readonly ts.JsxAttributeLike[] {
  return (ts.isJsxSelfClosingElement(node) ? node.attributes : node.openingElement.attributes).properties;
}

export function childrenOf(node: JsxElementLike): readonly ts.JsxChild[] {
  return ts.isJsxSelfClosingElement(node) ? [] : node.children;
}

export function getTagName(node: JsxElementLike): string | undefined {
  const tagName = ts.isJsxSelfClosingElement(node) ? node.tagName : node.openingElement.tagName;
  return ts.isIdentifier(tagName) ? tagName.text : undefined;
}

export function findAttr(attrs: readonly ts.JsxAttributeLike[], name: string): ts.JsxAttribute | undefined {
  return attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name);
}

/** A literal string attribute value, from either `name="x"` or `name={"x"}` form — undefined for anything else (identifier, call, missing). */
export function literalAttrValue(attr: ts.JsxAttribute | undefined): string | undefined {
  const initializer = attr?.initializer;
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteralLike(initializer.expression)) {
    return initializer.expression.text;
  }
  return undefined;
}

function truncate(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function describeChild(child: ts.JsxChild): string {
  if (isJsxElementLike(child)) {
    const tag = getTagName(child) ?? "?";
    return ts.isJsxSelfClosingElement(child) ? `<${tag}/>` : `<${tag}>`;
  }
  if (ts.isJsxFragment(child)) return "<>";
  return truncate(child.getText());
}

type TextResult = { text: string } | { error: string };

/** For headings/figcaption/span/link-labels: plain text only, zero nested elements — matches the mdx heading block's plain-string shape. */
function extractPlainText(children: readonly ts.JsxChild[]): TextResult {
  const parts: string[] = [];
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim() === "") continue;
      parts.push(child.text);
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue;
      if (ts.isStringLiteralLike(child.expression)) {
        parts.push(child.expression.text);
        continue;
      }
      return { error: `contains a non-literal expression "${truncate(child.expression.getText())}"` };
    }
    return { error: `contains nested element ${describeChild(child)}` };
  }
  return { text: parts.join("").trim() };
}

type InlineResult = { inline: InlineNode[] } | { error: string };

/** For p/blockquote: text plus a narrow set of nestable inline marks (strong/em/code/link), each recursively validated the same way. */
function extractInline(children: readonly ts.JsxChild[]): InlineResult {
  const nodes: InlineNode[] = [];
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim() === "") continue;
      nodes.push({ type: "text", text: child.text });
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue;
      if (ts.isStringLiteralLike(child.expression)) {
        nodes.push({ type: "text", text: child.expression.text });
        continue;
      }
      return { error: `contains a non-literal expression "${truncate(child.expression.getText())}"` };
    }
    if (ts.isJsxFragment(child)) {
      const inner = extractInline(child.children);
      if ("error" in inner) return inner;
      nodes.push(...inner.inline);
      continue;
    }
    if (isJsxElementLike(child)) {
      const tag = getTagName(child);
      if (tag === "strong" || tag === "b") {
        const inner = extractInline(childrenOf(child));
        if ("error" in inner) return inner;
        nodes.push({ type: "strong", children: inner.inline });
        continue;
      }
      if (tag === "em" || tag === "i") {
        const inner = extractInline(childrenOf(child));
        if ("error" in inner) return inner;
        nodes.push({ type: "emphasis", children: inner.inline });
        continue;
      }
      if (tag === "code") {
        const plain = extractPlainText(childrenOf(child));
        if ("error" in plain) return plain;
        nodes.push({ type: "inlineCode", code: plain.text });
        continue;
      }
      if (tag === "a" || tag === "Link") {
        const href = literalAttrValue(findAttr(attributesOf(child), "href"));
        if (href === undefined) return { error: `link is missing a literal string "href"` };
        const inner = extractInline(childrenOf(child));
        if ("error" in inner) return inner;
        nodes.push({ type: "link", href, children: inner.inline });
        continue;
      }
      return { error: `paragraph contains unsupported nested tag <${tag ?? "?"}>` };
    }
  }
  return { inline: nodes };
}

type FieldResult = { value: StaticFieldValue } | { error: string };

function extractImage(node: JsxElementLike): FieldResult {
  const attrs = attributesOf(node);
  const srcAttr = findAttr(attrs, "src");
  if (!srcAttr) return { error: `missing a "src" attribute` };
  const src = literalAttrValue(srcAttr);
  if (src === undefined) {
    return { error: `src is not a plain string literal (likely a static image import) — not supported yet` };
  }
  const altAttr = findAttr(attrs, "alt");
  const alt = altAttr ? (literalAttrValue(altAttr) ?? "") : "";
  return { value: { kind: "image", src, alt } };
}

function extractContentTag(node: JsxElementLike, tag: string): FieldResult {
  if (PLAIN_TEXT_TAGS.has(tag)) {
    const result = extractPlainText(childrenOf(node));
    if ("error" in result) return result;
    if (result.text === "") return { error: "element has no text content" };
    return { value: { kind: "text", text: result.text } };
  }
  if (tag === "p" || tag === "blockquote") {
    const result = extractInline(childrenOf(node));
    if ("error" in result) return result;
    if (result.inline.length === 0) return { error: "element has no content" };
    return { value: { kind: "richParagraph", inline: result.inline } };
  }
  if (IMAGE_TAGS.has(tag)) return extractImage(node);
  if (LINK_TAGS.has(tag)) {
    const label = extractPlainText(childrenOf(node));
    if ("error" in label) return label;
    if (label.text === "") return { error: "link has no visible text" };
    const href = literalAttrValue(findAttr(attributesOf(node), "href"));
    if (href === undefined) return { error: `link is missing a literal string "href"` };
    return { value: { kind: "linkPair", label: label.text, href } };
  }
  return { error: `unsupported tag <${tag}>` };
}

function isLogicalOrTernary(expr: ts.Expression): boolean {
  if (ts.isConditionalExpression(expr)) return true;
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind;
    return k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken;
  }
  return false;
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsJsx(child)) found = true;
  });
  return found;
}

function isRepeatCall(node: ts.CallExpression): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isPropertyAccessExpression(node.expression) && REPEAT_METHODS.has(node.expression.name.text);
}

interface RegionAcc {
  hint: string;
  start: number;
  end: number;
  fields: StaticFieldCandidate[];
}

interface Ctx {
  region: RegionAcc | null;
  componentName: string;
  skip: boolean;
}

/**
 * Walks a page/section file's JSX tree looking for static, unconditionally-
 * rendered, pure-literal content (headings, paragraphs, images, standalone
 * links) grouped into regions at semantic HTML5 boundary tags (falling back
 * to one region per component when no boundary tag is present). Mirrors
 * findRepeatingContent's "detect but don't guess" posture: anything mixed
 * with a JS expression, conditionally rendered, or otherwise ambiguous is
 * reported as unanalyzable with a reason, never silently flattened.
 */
export function findStaticContent(sourceText: string, filePath: string): StaticContentAnalysisResult {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const staticContent: StaticContentCandidate[] = [];
  const unanalyzable: UnanalyzableStaticCandidate[] = [];
  const fallbackRegions = new Map<string, RegionAcc>();
  const tagOrdinals = new Map<string, number>();

  function addUnanalyzable(node: ts.Node, hint: string, reason: string): void {
    unanalyzable.push({ sourceFile: filePath, regionHint: hint, reason, nodeStart: node.getStart(source), nodeEnd: node.getEnd() });
  }

  function pushField(region: RegionAcc, field: StaticFieldCandidate): void {
    region.fields.push(field);
    region.start = region.fields.length === 1 ? field.nodeStart : Math.min(region.start, field.nodeStart);
    region.end = region.fields.length === 1 ? field.nodeEnd : Math.max(region.end, field.nodeEnd);
  }

  function getOrCreateFallback(componentName: string): RegionAcc {
    const existing = fallbackRegions.get(componentName);
    if (existing) return existing;
    const region: RegionAcc = { hint: componentName, start: 0, end: 0, fields: [] };
    fallbackRegions.set(componentName, region);
    return region;
  }

  function openBoundaryRegion(tag: string, node: JsxElementLike): RegionAcc {
    const idHint = literalAttrValue(findAttr(attributesOf(node), "id"));
    const classHint = literalAttrValue(findAttr(attributesOf(node), "className"))?.trim().split(/\s+/)[0];
    const ordinal = (tagOrdinals.get(tag) ?? 0) + 1;
    tagOrdinals.set(tag, ordinal);
    const hint = idHint || classHint || `${tag}-${ordinal}`;
    return { hint, start: node.getStart(source), end: node.getEnd(), fields: [] };
  }

  function nameOfNamedFunctionLike(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      return node.name.text;
    }
    return undefined;
  }

  function visit(node: ts.Node, ctx: Ctx): void {
    if (ctx.skip) return;

    const componentName = nameOfNamedFunctionLike(node) ?? ctx.componentName;

    if (ts.isJsxExpression(node) && node.expression) {
      const expr = node.expression;
      if (isLogicalOrTernary(expr)) {
        if (containsJsx(expr)) {
          addUnanalyzable(node, ctx.region?.hint ?? componentName, "conditionally rendered — extracting would change whether this always renders");
        }
        return;
      }
    }

    if (ts.isCallExpression(node) && isRepeatCall(node)) {
      visit(node.expression.expression, { ...ctx, componentName });
      for (const arg of node.arguments) visit(arg, { ...ctx, componentName, skip: true });
      return;
    }

    if (ts.isJsxFragment(node)) {
      for (const child of node.children) visit(child, { ...ctx, componentName });
      return;
    }

    if (isJsxElementLike(node)) {
      const tag = getTagName(node);
      if (tag) {
        if (ctx.region === null && BOUNDARY_TAGS.has(tag)) {
          const region = openBoundaryRegion(tag, node);
          for (const child of childrenOf(node)) visit(child, { ...ctx, region, componentName });
          if (region.fields.length > 0) staticContent.push({ sourceFile: filePath, regionHint: region.hint, regionStart: region.start, regionEnd: region.end, fields: region.fields });
          return;
        }
        if (CONTENT_TAGS.has(tag)) {
          const region = ctx.region ?? getOrCreateFallback(componentName);
          const result = extractContentTag(node, tag);
          if ("error" in result) {
            addUnanalyzable(node, region.hint, result.error);
          } else {
            pushField(region, { tag, value: result.value, nodeStart: node.getStart(source), nodeEnd: node.getEnd() });
          }
          return;
        }
      }
      for (const child of childrenOf(node)) visit(child, { ...ctx, componentName });
      return;
    }

    ts.forEachChild(node, (child) => visit(child, { ...ctx, componentName }));
  }

  visit(source, { region: null, componentName: "page", skip: false });

  for (const region of fallbackRegions.values()) {
    if (region.fields.length > 0) {
      staticContent.push({ sourceFile: filePath, regionHint: region.hint, regionStart: region.start, regionEnd: region.end, fields: region.fields });
    }
  }

  return { staticContent, unanalyzable };
}
