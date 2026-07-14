import path from "node:path";
import ts from "typescript";

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits right-to-left so earlier offsets stay valid as later ones are spliced in. */
export function applyEdits(source: string, edits: TextEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

export function lineIndentBefore(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const prefix = text.slice(lineStart, pos);
  return /^\s*$/.test(prefix) ? prefix : "";
}

/** Expands [start, end) to cover the whole source line(s), including one trailing newline, so deleting a statement doesn't leave a blank line behind. */
export function expandToFullLines(text: string, start: number, end: number): { start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const canExpandStart = /^\s*$/.test(text.slice(lineStart, start));
  const newStart = canExpandStart ? lineStart : start;

  let newEnd = end;
  if (text[newEnd] === "\n") newEnd += 1;
  else if (text[newEnd] === "\r" && text[newEnd + 1] === "\n") newEnd += 2;

  return { start: newStart, end: newEnd };
}

export function toImportSpecifier(fromFile: string, configFilePath: string): string {
  const relDir = path.relative(path.dirname(fromFile), path.dirname(configFilePath));
  const base = path.basename(configFilePath).replace(/\.tsx?$/, "");
  const joined = [relDir, base].filter(Boolean).join("/").split(path.sep).join("/");
  return joined.startsWith(".") ? joined : `./${joined}`;
}

export function ensureDefaultImport(sourceText: string, moduleSpecifier: string, localName: string): string {
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

export function findNodeAtPosition(source: ts.SourceFile, pos: number): ts.Node {
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

export type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

export function findEnclosingFunction(node: ts.Node): FunctionLike | null {
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

export function isAsyncFunction(fn: FunctionLike): boolean {
  return ts.canHaveModifiers(fn) ? (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false) : false;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isValidIdentifierName(name: string): boolean {
  return IDENTIFIER_PATTERN.test(name);
}

/** Formats `name` as an object/type-literal property key — bare if it's a valid JS identifier, quoted otherwise. Needed because cimisy's kebab-case field names (e.g. "image-alt", generated from the slug charset) aren't valid bare identifiers. */
export function objectKeyFor(name: string): string {
  return isValidIdentifierName(name) ? name : JSON.stringify(name);
}

/** `${objExpr}.name` when `name` is a valid identifier, or `${objExpr}["name"]` bracket access otherwise — same charset problem as objectKeyFor, for property *reads* instead of declarations. */
export function propertyAccess(objExpr: string, name: string): string {
  return isValidIdentifierName(name) ? `${objExpr}.${name}` : `${objExpr}[${JSON.stringify(name)}]`;
}

export function buildAsyncEdit(fn: FunctionLike, source: ts.SourceFile): TextEdit | null {
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
