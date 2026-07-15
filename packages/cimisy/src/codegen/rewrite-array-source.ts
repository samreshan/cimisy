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
  /**
   * Char offsets of the `const X = [...]` statement, as captured by
   * findRepeatingContent against THIS SAME sourceText (stale offsets from
   * a re-scanned/edited file produce corrupted output). Omit both when the
   * array is declared in a different module than this one (a
   * RepeatingContentCandidate whose declarationFile !== sourceFile) — that
   * module's declaration is deleted separately by the caller via
   * deleteArrayDeclaration, and this rewrite instead removes the stale
   * import of `variableName` from this file.
   */
  declarationStart?: number;
  declarationEnd?: number;
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

/** `as {...}` type assertions are TypeScript-only syntax — inserting one into a plain .js/.jsx file (a valid App Router page/component shape) would leave behind code that fails to even parse. */
function isTypeScriptFile(filePath: string): boolean {
  return /\.tsx?$/.test(filePath);
}

function fetchReplacementLines(
  indent: string,
  variableName: string,
  collectionName: string,
  fieldsProposal: FieldProposal[],
  useTypeCast: boolean,
): string {
  const castSuffix = useTypeCast ? ` as ${buildValuesCastType(fieldsProposal)}` : "";
  return [
    `const cimisyReader = createReader(cimisyConfig);`,
    `${indent}const ${variableName} = (await cimisyReader.collections.${collectionName}.all()).map((entry) => entry.values${castSuffix});`,
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
  useTypeCast: boolean,
): TextEdit {
  const outerIndent = lineIndentBefore(sourceText, fn.getStart(source));
  const innerIndent = `${outerIndent}  `;

  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const bodyStart = fn.body.getStart(source);
    const bodyEnd = fn.body.getEnd();
    const originalBodyText = sourceText.slice(bodyStart, bodyEnd);
    const text = `{\n${innerIndent}${fetchReplacementLines(innerIndent, variableName, collectionName, fieldsProposal, useTypeCast)}\n${innerIndent}return ${originalBodyText};\n${outerIndent}}`;
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
    text: `\n${innerIndent}${fetchReplacementLines(innerIndent, variableName, collectionName, fieldsProposal, useTypeCast)}`,
  };
}

/** Deletes just an array's own declaration statement — used to rewrite a candidate's declarationFile when it's a different module than the one rewriteArraySource is handling (see RewriteArraySourceOptions). */
export function deleteArrayDeclaration(sourceText: string, declarationStart: number, declarationEnd: number): string {
  const { start, end } = expandToFullLines(sourceText, declarationStart, declarationEnd);
  return sourceText.slice(0, start) + sourceText.slice(end);
}

/** Removes the default-import binding `localName` (dropping the whole import statement if there are no named specifiers alongside it, otherwise just the `X,` / `, X` default clause) — the default-import counterpart of the named-specifier removal below. */
function removeDefaultImportBinding(sourceText: string, source: ts.SourceFile, statement: ts.ImportDeclaration): string {
  const { importClause } = statement;
  const namedBindings = importClause!.namedBindings;
  if (!namedBindings || (ts.isNamedImports(namedBindings) && namedBindings.elements.length === 0)) {
    const { start, end } = expandToFullLines(sourceText, statement.getStart(source), statement.getEnd());
    return sourceText.slice(0, start) + sourceText.slice(end);
  }
  // A default import always comes first in the clause — safe to delete from the clause's start through the following comma/whitespace up to the named bindings.
  const start = importClause!.getStart(source);
  const end = namedBindings.getStart(source);
  return sourceText.slice(0, start) + sourceText.slice(end);
}

/** Removes the import binding for `localName` — a named specifier (dropping the whole import statement if it was the only specifier and there's no default import alongside it) or a default import (see removeDefaultImportBinding) — the cross-file counterpart of deleting a local declaration, since `variableName` is no longer available as an import once its source array is gone. Leaves sourceText untouched if no matching import is found (shouldn't normally happen; findRepeatingContent only takes this path after finding exactly this import). */
function removeImportBinding(sourceText: string, filePath: string, localName: string): string {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;

    if (statement.importClause.name?.text === localName) {
      return removeDefaultImportBinding(sourceText, source, statement);
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    const elements = namedBindings.elements;
    const idx = elements.findIndex((el) => el.name.text === localName);
    if (idx === -1) continue;

    if (elements.length === 1 && !statement.importClause.name) {
      const { start, end } = expandToFullLines(sourceText, statement.getStart(source), statement.getEnd());
      return sourceText.slice(0, start) + sourceText.slice(end);
    }
    const target = elements[idx]!;
    const isLast = idx === elements.length - 1;
    const start = isLast ? elements[idx - 1]!.getEnd() : target.getStart(source);
    const end = isLast ? target.getEnd() : elements[idx + 1]!.getStart(source);
    return sourceText.slice(0, start) + sourceText.slice(end);
  }
  return sourceText;
}

/**
 * The safe array->fetch swap: removes the `const X = [...]` array
 * declaration (or, when it lives in a different module — see
 * declarationStart/declarationEnd's doc comment — the stale import of it)
 * and inserts, inside the function that actually consumes it via
 * `.map()`, a fetch producing the exact same flat per-item shape
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

  const edits: TextEdit[] = [
    buildBodyInsertEdit(fn, source, sourceText, variableName, collectionName, fields, isTypeScriptFile(filePath)),
  ];
  const asyncEdit = buildAsyncEdit(fn, source);
  if (asyncEdit) edits.push(asyncEdit);
  const hasLocalDeclaration = declarationStart !== undefined && declarationEnd !== undefined;
  if (hasLocalDeclaration) {
    const deletion = expandToFullLines(sourceText, declarationStart, declarationEnd);
    edits.push({ start: deletion.start, end: deletion.end, text: "" });
  }

  let afterEdits = applyEdits(sourceText, edits);
  if (!hasLocalDeclaration) {
    afterEdits = removeImportBinding(afterEdits, filePath, variableName);
  }

  const configImportSpecifier = toImportSpecifier(filePath, configFilePath);
  const withReaderImport = ensureNamedImport(afterEdits, "cimisy/next", ["createReader"]);
  return ensureDefaultImport(withReaderImport, configImportSpecifier, "cimisyConfig");
}
