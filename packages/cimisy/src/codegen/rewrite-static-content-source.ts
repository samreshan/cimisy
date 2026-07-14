import ts from "typescript";
import {
  attributesOf,
  findAttr,
  isJsxElementLike,
  type JsxElementLike,
  type StaticFieldCandidate,
} from "../scan/analyze-static-content.js";
import type { StaticFieldAssignment, StaticFieldProposal, StaticFieldProposalKind } from "../scan/infer-static-schema.js";
import { ensureNamedImport } from "./insert-collection-config.js";
import {
  applyEdits,
  buildAsyncEdit,
  ensureDefaultImport,
  expandToFullLines,
  findEnclosingFunction,
  findNodeAtPosition,
  lineIndentBefore,
  objectKeyFor,
  propertyAccess,
  toImportSpecifier,
  type TextEdit,
} from "./source-edit-utils.js";

export type ReaderPath = { kind: "page-section"; pageKey: string; sectionKey: string } | { kind: "singleton"; key: string };

export interface RewriteStaticContentSourceOptions {
  sourceText: string;
  /** Absolute path of the file being rewritten. */
  filePath: string;
  /** Absolute path of cimisy.config.ts. */
  configFilePath: string;
  /** Local variable name the fetched value is bound to, e.g. "heroContent". */
  variableName: string;
  readerPath: ReaderPath;
  /** The same StaticFieldCandidate[] captured by findStaticContent against THIS SAME sourceText (stale offsets from a re-scanned/edited file produce corrupted output). */
  fields: StaticFieldCandidate[];
  /** Parallel to `fields` — from inferStaticSchema's StaticSchemaProposal.fieldAssignments. */
  fieldAssignments: StaticFieldAssignment[];
  /** The schema proposal's own fields — used to build the values cast type and fallback object literal. */
  proposalFields: StaticFieldProposal[];
  /** Char offset of any node inside the region (e.g. its first field's nodeStart) — locates the enclosing function to rewrite, same role as the array codemod's mapCallStart. */
  anchorPos: number;
}

function tsTypeForStaticField(kind: StaticFieldProposalKind): string {
  switch (kind) {
    case "text":
      return "string";
    case "image":
      return "string | null";
    case "blocks":
      return "import(\"cimisy/config\").BlockNode[]";
  }
}

function fallbackLiteralForStaticField(kind: StaticFieldProposalKind): string {
  switch (kind) {
    case "text":
      return '""';
    case "image":
      return "null";
    case "blocks":
      return "[]";
  }
}

function buildValuesCastType(fields: StaticFieldProposal[]): string {
  return `{ ${fields.map((f) => `${objectKeyFor(f.name)}: ${tsTypeForStaticField(f.proposedKind)}`).join("; ")} }`;
}

function buildFallbackObjectLiteral(fields: StaticFieldProposal[]): string {
  return `{ ${fields.map((f) => `${objectKeyFor(f.name)}: ${fallbackLiteralForStaticField(f.proposedKind)}`).join(", ")} }`;
}

function readerGetExpression(readerPath: ReaderPath): string {
  return readerPath.kind === "singleton"
    ? `cimisyReader.singletons.${readerPath.key}.get()`
    : `cimisyReader.pages.${readerPath.pageKey}.${readerPath.sectionKey}.get()`;
}

function fetchReplacementLines(indent: string, variableName: string, readerPath: ReaderPath, proposalFields: StaticFieldProposal[]): string {
  const castType = buildValuesCastType(proposalFields);
  const fallback = buildFallbackObjectLiteral(proposalFields);
  return [
    `const cimisyReader = createReader(cimisyConfig);`,
    `${indent}const ${variableName} = ((await ${readerGetExpression(readerPath)})?.values as ${castType}) ?? ${fallback};`,
  ].join("\n");
}

function findJsxElementAtSpan(source: ts.SourceFile, start: number, end: number): JsxElementLike {
  let found: JsxElementLike | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isJsxElementLike(node) && node.getStart(source) === start && node.getEnd() === end) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) {
    throw new Error(
      `Could not re-locate the JSX element at [${start}, ${end}) — the source file may have changed since it was scanned; re-run "cimisy scan --full".`,
    );
  }
  return found;
}

/** [openingTagEnd, closingTagStart) — the replaceable "content" span of an element that has real (non-self-closing) children. */
function childrenSpanOf(node: JsxElementLike): [number, number] {
  if (!ts.isJsxElement(node)) {
    throw new Error("Expected a non-self-closing element with children to replace.");
  }
  return [node.openingElement.getEnd(), node.closingElement.getStart()];
}

function requiredAttrEdit(node: JsxElementLike, name: string, shift: number, exprText: string): TextEdit {
  const attr = findAttr(attributesOf(node), name);
  if (!attr?.initializer) {
    throw new Error(`Expected element to already have a literal "${name}" attribute (scan-time validity guarantees this).`);
  }
  return { start: attr.initializer.getStart() + shift, end: attr.initializer.getEnd() + shift, text: `{${exprText}}` };
}

/** Replaces an existing `alt="..."` attribute in place, or inserts a brand-new `alt={...}` right after the last attribute (or the tag name, if there are none) — a structurally different edit than replacing an existing one. */
function altAttrEdit(node: JsxElementLike, shift: number, exprText: string): TextEdit {
  const attrs = attributesOf(node);
  const existing = findAttr(attrs, "alt");
  if (existing?.initializer) {
    return { start: existing.initializer.getStart() + shift, end: existing.initializer.getEnd() + shift, text: `{${exprText}}` };
  }
  const insertAfter = attrs.length > 0 ? attrs[attrs.length - 1]!.getEnd() : (ts.isJsxSelfClosingElement(node) ? node.tagName : node.openingElement.tagName).getEnd();
  const pos = insertAfter + shift;
  return { start: pos, end: pos, text: ` alt={${exprText}}` };
}

/**
 * The safe JSX->fetch swap for static content: locates the function that
 * renders this region (via the same enclosing-function search the array
 * codemod uses), inserts a reader fetch as its first statement (wrapping a
 * concise arrow body into a block if needed, exactly like the array
 * codemod), marks it async if needed — then, in a SECOND pass over the
 * now-structurally-edited text, replaces each scanned field's original JSX
 * (a heading's text, an image's src/alt, a link's label/href, or a merged
 * paragraph run) with a read from the fetched value. The two passes are
 * necessary (unlike the array codemod, which never touches the JSX at
 * all): pass one's insertions land strictly BEFORE every field's original
 * position (all fields live inside the function body pass one edits the
 * start of), so a single per-pass-one "characters inserted" count is added
 * to every field offset before pass two runs — never re-deriving offsets
 * from a stale parse.
 */
export function rewriteStaticContentSource(options: RewriteStaticContentSourceOptions): string {
  const { sourceText, filePath, configFilePath, variableName, readerPath, fields, fieldAssignments, proposalFields, anchorPos } = options;

  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const anchorNode = findNodeAtPosition(source, anchorPos);
  const fn = findEnclosingFunction(anchorNode);
  if (!fn) {
    throw new Error("Could not find the function that renders this content — refusing to insert an `await` outside a function.");
  }

  const structuralEdits: TextEdit[] = [];
  const asyncEdit = buildAsyncEdit(fn, source);
  if (asyncEdit) structuralEdits.push(asyncEdit);
  let insertedBeforeFields = asyncEdit ? asyncEdit.text.length : 0;

  const outerIndent = lineIndentBefore(sourceText, fn.getStart(source));
  const innerIndent = `${outerIndent}  `;

  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const bodyStart = fn.body.getStart(source);
    const bodyEnd = fn.body.getEnd();
    const openText = `{\n${innerIndent}${fetchReplacementLines(innerIndent, variableName, readerPath, proposalFields)}\n${innerIndent}return `;
    structuralEdits.push({ start: bodyStart, end: bodyStart, text: openText });
    structuralEdits.push({ start: bodyEnd, end: bodyEnd, text: `;\n${outerIndent}}` });
    insertedBeforeFields += openText.length;
  } else {
    const block = fn.body;
    if (!block || !ts.isBlock(block)) {
      throw new Error("Expected a block-bodied function — cannot safely locate an insertion point.");
    }
    const openBracePos = block.getStart(source) + 1;
    const insertText = `\n${innerIndent}${fetchReplacementLines(innerIndent, variableName, readerPath, proposalFields)}`;
    structuralEdits.push({ start: openBracePos, end: openBracePos, text: insertText });
    insertedBeforeFields += insertText.length;
  }

  const afterStructural = applyEdits(sourceText, structuralEdits);

  const fieldEdits: TextEdit[] = [];
  const seenMergedFields = new Set<string>();

  fields.forEach((field, index) => {
    const assignment = fieldAssignments[index]!;
    const shift = insertedBeforeFields;

    if (assignment.kind === "richParagraph") {
      if (seenMergedFields.has(assignment.mergedFieldName)) {
        const deletion = expandToFullLines(afterStructural, field.nodeStart + shift, field.nodeEnd + shift);
        fieldEdits.push({ start: deletion.start, end: deletion.end, text: "" });
      } else {
        seenMergedFields.add(assignment.mergedFieldName);
        fieldEdits.push({
          start: field.nodeStart + shift,
          end: field.nodeEnd + shift,
          text: `{renderBlocks(${propertyAccess(variableName, assignment.mergedFieldName)})}`,
        });
      }
      return;
    }

    const elementNode = findJsxElementAtSpan(source, field.nodeStart, field.nodeEnd);

    if (assignment.kind === "text") {
      const [openEnd, closeStart] = childrenSpanOf(elementNode);
      fieldEdits.push({ start: openEnd + shift, end: closeStart + shift, text: `{${propertyAccess(variableName, assignment.name)}}` });
      return;
    }
    if (assignment.kind === "linkPair") {
      const [openEnd, closeStart] = childrenSpanOf(elementNode);
      fieldEdits.push({ start: openEnd + shift, end: closeStart + shift, text: `{${propertyAccess(variableName, assignment.labelName)}}` });
      const hrefAttrEdit = requiredAttrEdit(elementNode, "href", shift, `${propertyAccess(variableName, assignment.hrefName)} ?? ""`);
      fieldEdits.push(hrefAttrEdit);
      return;
    }
    // image
    fieldEdits.push(requiredAttrEdit(elementNode, "src", shift, `${propertyAccess(variableName, assignment.name)} ?? ""`));
    fieldEdits.push(altAttrEdit(elementNode, shift, propertyAccess(variableName, assignment.altName)));
  });

  const afterFields = applyEdits(afterStructural, fieldEdits);

  const configImportSpecifier = toImportSpecifier(filePath, configFilePath);
  let result = ensureNamedImport(afterFields, "cimisy/next", ["createReader"]);
  result = ensureDefaultImport(result, configImportSpecifier, "cimisyConfig");
  if (proposalFields.some((f) => f.proposedKind === "blocks")) {
    result = ensureNamedImport(result, "cimisy/render", ["renderBlocks"]);
  }
  return result;
}
