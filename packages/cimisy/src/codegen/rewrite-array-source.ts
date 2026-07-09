import path from "node:path";
import ts from "typescript";
import type { FieldProposal, ProposedFieldKind } from "../scan/infer-schema.js";
import { ensureNamedImport } from "./insert-collection-config.js";

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

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits right-to-left so earlier offsets stay valid as later ones are spliced in. */
function applyEdits(source: string, edits: TextEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function lineIndentBefore(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const prefix = text.slice(lineStart, pos);
  return /^\s*$/.test(prefix) ? prefix : "";
}

/** Expands [start, end) to cover the whole source line(s), including one trailing newline, so deleting a statement doesn't leave a blank line behind. */
function expandToFullLines(text: string, start: number, end: number): { start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const canExpandStart = /^\s*$/.test(text.slice(lineStart, start));
  const newStart = canExpandStart ? lineStart : start;

  let newEnd = end;
  if (text[newEnd] === "\n") newEnd += 1;
  else if (text[newEnd] === "\r" && text[newEnd + 1] === "\n") newEnd += 2;

  return { start: newStart, end: newEnd };
}

function toImportSpecifier(fromFile: string, configFilePath: string): string {
  const relDir = path.relative(path.dirname(fromFile), path.dirname(configFilePath));
  const base = path.basename(configFilePath).replace(/\.tsx?$/, "");
  const joined = [relDir, base].filter(Boolean).join("/").split(path.sep).join("/");
  return joined.startsWith(".") ? joined : `./${joined}`;
}

function ensureDefaultImport(sourceText: string, moduleSpecifier: string, localName: string): string {
  const source = ts.createSourceFile("x.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleSpecifier) continue;
    if (statement.importClause?.name?.text === localName) return sourceText;
  }
  const lastImport = [...source.statements].filter(ts.isImportDeclaration).pop();
  const newLine = `import ${localName} from ${JSON.stringify(moduleSpecifier)};`;
  if (lastImport) {
    const insertPos = lastImport.getEnd();
    return sourceText.slice(0, insertPos) + `\n${newLine}` + sourceText.slice(insertPos);
  }
  return `${newLine}\n${sourceText}`;
}

function findNodeAtPosition(source: ts.SourceFile, pos: number): ts.Node {
  let result: ts.Node = source;
  const visit = (node: ts.Node): void => {
    if (pos >= node.getStart(source) && pos < node.getEnd()) {
      result = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return result;
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function findEnclosingFunction(node: ts.Node): FunctionLike | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function isAsyncFunction(fn: FunctionLike): boolean {
  return ts.canHaveModifiers(fn) ? (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false) : false;
}

function buildAsyncEdit(fn: FunctionLike, source: ts.SourceFile): TextEdit | null {
  if (isAsyncFunction(fn)) return null;
  if (ts.isArrowFunction(fn)) {
    const pos = fn.getStart(source);
    return { start: pos, end: pos, text: "async " };
  }
  if (ts.isMethodDeclaration(fn)) {
    const pos = fn.name.getStart(source);
    return { start: pos, end: pos, text: "async " };
  }
  const functionKeyword = fn.getChildren(source).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
  if (!functionKeyword) {
    throw new Error("Could not locate the `function` keyword to insert `async` before.");
  }
  const pos = functionKeyword.getStart(source);
  return { start: pos, end: pos, text: "async " };
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
