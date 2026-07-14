import ts from "typescript";
import type { FieldProposal, ProposedFieldKind } from "../scan/infer-schema.js";
import { ensureNamedImport } from "./insert-collection-config.js";
import {
  applyEdits,
  buildAsyncEdit,
  ensureDefaultImport,
  expandToFullLines,
  findEnclosingFunction,
  findNodeAtPosition,
  lineIndentBefore,
  toImportSpecifier,
  type FunctionLike,
  type TextEdit,
} from "./source-edit-utils.js";

export interface RewriteArraySourceOptions {
  sourceText: string;
  /** Absolute path of the file being rewritten. */
  filePath: string;
  /** Absolute path of cimisy.config.ts. */
  configFilePath: string;
  variableName: string;
  collectionName: string;
  /** The collection's inferred fields (NOT including the synthesized slug) — used to type-cast `entry.values` back to the shape the pre-existing JSX already expects, since a Reader entry's `values` is `Record<string, unknown>` at the type level even though every field here is actually a string/string[] at runtime. */
  fields: FieldProposal[];
  /** Char offsets of the `const X = [...]` statement, as captured by findRepeatingContent against THIS SAME sourceText (stale offsets from a re-scanned/edited file produce corrupted output). */
  declarationStart: number;
  declarationEnd: number;
  /** Char offset of the `X.map(` call — see analyze-source.ts's RepeatingContentCandidate for why this, not declarationStart, locates the function to rewrite. */
  mapCallStart: number;
}

function tsTypeForField(kind: ProposedFieldKind): string {
  switch (kind) {
    case "text":
      return "string";
    case "array-of-text":
      return "string[]";
    case "image":
      return "string | null";
  }
}

/** e.g. `{ q: string; a: string }` — the exact shape the pre-existing JSX/map body already expects. */
function buildValuesCastType(fieldsProposal: FieldProposal[]): string {
  return `{ ${fieldsProposal.map((f) => `${f.name}: ${tsTypeForField(f.proposedKind)}`).join("; ")} }`;
}

function fetchReplacementLines(indent: string, variableName: string, collectionName: string, fieldsProposal: FieldProposal[]): string {
  const castType = buildValuesCastType(fieldsProposal);
  return [
    `const cimisyReader = createReader(cimisyConfig);`,
    `${indent}const ${variableName} = (await cimisyReader.collections.${collectionName}.all()).map((entry) => entry.values as ${castType});`,
  ].join("\n");
}

/**
 * Inserts the fetch as the first statement of the function body that
 * actually consumes the array (never the array's own declaration site,
 * which is frequently module scope — a top-level `await` there would
 * often land outside any function at all). If the function has a concise
 * (non-block) arrow body, it's wrapped into a block; the original
 * expression is preserved verbatim as the new `return` statement.
 */
function buildBodyInsertEdit(
  fn: FunctionLike,
  source: ts.SourceFile,
  sourceText: string,
  variableName: string,
  collectionName: string,
  fieldsProposal: FieldProposal[],
): TextEdit {
  const outerIndent = lineIndentBefore(sourceText, fn.getStart(source));
  const innerIndent = `${outerIndent}  `;

  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const bodyStart = fn.body.getStart(source);
    const bodyEnd = fn.body.getEnd();
    const originalBodyText = sourceText.slice(bodyStart, bodyEnd);
    const text = `{\n${innerIndent}${fetchReplacementLines(innerIndent, variableName, collectionName, fieldsProposal)}\n${innerIndent}return ${originalBodyText};\n${outerIndent}}`;
    return { start: bodyStart, end: bodyEnd, text };
  }

  const block = fn.body;
  if (!block || !ts.isBlock(block)) {
    throw new Error("Expected a block-bodied function — cannot safely locate an insertion point.");
  }
  const openBracePos = block.getStart(source) + 1;
  return {
    start: openBracePos,
    end: openBracePos,
    text: `\n${innerIndent}${fetchReplacementLines(innerIndent, variableName, collectionName, fieldsProposal)}`,
  };
}

/**
 * The safe array->fetch swap: removes the `const X = [...]` array
 * declaration and inserts, inside the function that actually consumes it
 * via `.map()`, a fetch producing the exact same flat per-item shape
 * (`entry.values`, not cimisy's `{slug, version, values, error?}`
 * wrapper) — so the pre-existing `.map()` call and all JSX downstream of
 * it never need to be touched. Marks that function async if needed, and
 * ensures the `createReader`/config imports it depends on.
 */
export function rewriteArraySource(options: RewriteArraySourceOptions): string {
  const { sourceText, filePath, configFilePath, variableName, collectionName, fields, declarationStart, declarationEnd, mapCallStart } =
    options;

  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mapNode = findNodeAtPosition(source, mapCallStart);
  const fn = findEnclosingFunction(mapNode);
  if (!fn) {
    throw new Error(
      "Could not find the function that consumes this array via `.map()` — refusing to insert an `await` outside a function.",
    );
  }

  const edits: TextEdit[] = [buildBodyInsertEdit(fn, source, sourceText, variableName, collectionName, fields)];
  const asyncEdit = buildAsyncEdit(fn, source);
  if (asyncEdit) edits.push(asyncEdit);
  const deletion = expandToFullLines(sourceText, declarationStart, declarationEnd);
  edits.push({ start: deletion.start, end: deletion.end, text: "" });

  const afterEdits = applyEdits(sourceText, edits);

  const configImportSpecifier = toImportSpecifier(filePath, configFilePath);
  const withReaderImport = ensureNamedImport(afterEdits, "cimisy/next", ["createReader"]);
  return ensureDefaultImport(withReaderImport, configImportSpecifier, "cimisyConfig");
}
