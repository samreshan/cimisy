import { access, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type LiteralValue = string | number | boolean | null | LiteralValue[];

export interface RepeatingContentCandidate {
  variableName: string;
  /** The file whose `.map()` call consumes this array — see mapCallStart. */
  sourceFile: string;
  /**
   * The file the array is actually declared in — equal to `sourceFile` for
   * the common case (declared and mapped in the same file). Different when
   * the array lives in its own data module and is `.map()`'d after being
   * imported one hop away (see findRepeatingContent's cross-file
   * resolution) — the codemod needs this to know which file's declaration
   * to delete.
   */
  declarationFile: string;
  items: Array<Record<string, LiteralValue>>;
  /** Char offsets of the whole `const X = [...]` statement in declarationFile's text, for the later codemod's deletion. */
  declarationStart: number;
  declarationEnd: number;
  /**
   * Char offset of the `X.map(` call expression that consumes this array,
   * in sourceFile's text. The array declaration and its `.map()` usage are
   * often in different scopes (e.g. a module-scope array consumed inside a
   * component function, or a different file entirely) — the codemod needs
   * THIS position, not declarationStart, to find the right function to
   * make async and to insert an awaited fetch into (a top-level `await` at
   * the declaration's own scope would often be outside any function at
   * all, or in the wrong file).
   */
  mapCallStart: number;
}

export interface UnanalyzableArrayCandidate {
  variableName: string;
  sourceFile: string;
  declarationFile: string;
  reason: string;
}

export interface AnalyzeSourceResult {
  repeatingContent: RepeatingContentCandidate[];
  unanalyzable: UnanalyzableArrayCandidate[];
}

export interface JsxSectionCandidate {
  componentName: string;
  /** Resolved absolute path of the component's source file, or null if it couldn't be resolved (external package, alias miss, etc). */
  sourceFile: string | null;
}

const NOT_LITERAL = Symbol("not-literal");

function literalValueFromExpression(expr: ts.Expression, depth: number): LiteralValue | typeof NOT_LITERAL {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return -Number(expr.operand.text);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    if (depth >= 3) return NOT_LITERAL;
    const values: LiteralValue[] = [];
    for (const el of expr.elements) {
      const v = literalValueFromExpression(el, depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      values.push(v);
    }
    return values;
  }
  return NOT_LITERAL;
}

function objectLiteralToRecord(obj: ts.ObjectLiteralExpression): Record<string, LiteralValue> | { error: string } {
  const record: Record<string, LiteralValue> = {};
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      return { error: `property "${prop.getText()}" is not a plain key: value assignment (spread/shorthand/method are not supported)` };
    }
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (!key) return { error: "computed property keys are not supported" };
    const value = literalValueFromExpression(prop.initializer, 0);
    if (value === NOT_LITERAL) {
      return { error: `field "${key}" is not a literal value (expressions, function calls, and identifiers are not supported)` };
    }
    record[key] = value;
  }
  return record;
}

function findEnclosingStatement(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (current.parent && !ts.isVariableStatement(current.parent) && !ts.isSourceFile(current.parent)) {
    current = current.parent;
  }
  return ts.isVariableStatement(current.parent) ? current.parent : current;
}

/** Turns an array literal's elements into items, or a reason it can't be — shared by the local and cross-file declaration paths below. */
function evaluateArrayItems(elements: readonly ts.Expression[]): { items: Array<Record<string, LiteralValue>> } | { error: string } {
  const items: Array<Record<string, LiteralValue>> = [];
  for (const [index, element] of elements.entries()) {
    if (!ts.isObjectLiteralExpression(element)) {
      return { error: `item ${index} is not an object literal` };
    }
    const result = objectLiteralToRecord(element);
    if ("error" in result) return { error: `item ${index}: ${result.error}` };
    items.push(result);
  }
  if (items.length === 0) return { error: "array is empty, nothing to infer a schema from" };
  return { items };
}

interface ImportedArrayDeclaration {
  declarationFile: string;
  /** Char offsets of the whole declaration to delete in declarationFile's text — the `const X = [...]`/`export default [...]` statement, or the whole file for a `.json` data module (see the JSON branch below). */
  declarationStart: number;
  declarationEnd: number;
  evaluated: { items: Array<Record<string, LiteralValue>> } | { error: string };
}

/** JSON's value grammar is a subset of literalValueFromExpression's — reused here since `.json` data files are parsed with JSON.parse, not the TS parser (see resolveImportedArrayDeclaration's JSON branch). */
function jsonValueToLiteral(value: unknown, depth: number): LiteralValue | typeof NOT_LITERAL {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 3) return NOT_LITERAL;
    const values: LiteralValue[] = [];
    for (const el of value) {
      const v = jsonValueToLiteral(el, depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      values.push(v);
    }
    return values;
  }
  return NOT_LITERAL; // nested objects aren't a supported field shape, same ceiling as objectLiteralToRecord
}

function jsonObjectToRecord(obj: Record<string, unknown>): Record<string, LiteralValue> | { error: string } {
  const record: Record<string, LiteralValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    const v = jsonValueToLiteral(value, 0);
    if (v === NOT_LITERAL) return { error: `field "${key}" is not a supported literal value (nested objects are not supported)` };
    record[key] = v;
  }
  return record;
}

function evaluateJsonArrayItems(parsed: unknown[]): { items: Array<Record<string, LiteralValue>> } | { error: string } {
  const items: Array<Record<string, LiteralValue>> = [];
  for (const [index, element] of parsed.entries()) {
    if (typeof element !== "object" || element === null || Array.isArray(element)) {
      return { error: `item ${index} is not an object literal` };
    }
    const result = jsonObjectToRecord(element as Record<string, unknown>);
    if ("error" in result) return { error: `item ${index}: ${result.error}` };
    items.push(result);
  }
  if (items.length === 0) return { error: "array is empty, nothing to infer a schema from" };
  return { items };
}

/**
 * When a `.map()`'d identifier has no local declaration, checks whether
 * it's bound by an import — a plain named import (`import { leaders } from
 * "../../data/leadership"`) or a default import (`import chaptersRaw from
 * "../../data/about-timeline.json"` — the shape every `.json` data import
 * takes under webpack/Next's JSON interop, and also common for a plain
 * `export default [...]` data module) — and, if so, follows it one hop to
 * find the actual array. Data factored into its own module — leaderboard.js,
 * jobs.js, timeline.json, etc. — is arguably the *more* common shape than an
 * inline array, so leaving this unresolved would miss more real content than
 * it catches. Namespace imports (`import * as x`) stay unresolved.
 */
async function resolveImportedArrayDeclaration(
  source: ts.SourceFile,
  localName: string,
  filePath: string,
  options: { pathAliases?: Record<string, string>; projectRoot?: string },
): Promise<ImportedArrayDeclaration | null> {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const { importClause } = statement;
    const isDefaultImport = importClause.name?.text === localName;
    const namedBindings = importClause.namedBindings;
    const namedElement =
      namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements.find((el) => el.name.text === localName) : undefined;
    if (!isDefaultImport && !namedElement) continue;

    const projectRoot = options.projectRoot ?? path.dirname(filePath);
    const resolvedPath = await resolveModuleSpecifier(statement.moduleSpecifier.text, filePath, projectRoot, options.pathAliases ?? {});
    if (!resolvedPath) return null;

    let declarationText: string;
    try {
      declarationText = await readFile(resolvedPath, "utf8");
    } catch {
      return null;
    }

    if (isDefaultImport && resolvedPath.endsWith(".json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(declarationText);
      } catch {
        return null; // malformed JSON — the app itself wouldn't build either; not our problem to report
      }
      if (!Array.isArray(parsed)) return null; // resolved to a real file, but its root isn't an array
      return {
        declarationFile: resolvedPath,
        declarationStart: 0,
        declarationEnd: declarationText.length,
        evaluated: evaluateJsonArrayItems(parsed),
      };
    }

    const declSource = ts.createSourceFile(resolvedPath, declarationText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    if (isDefaultImport) {
      for (const declStatement of declSource.statements) {
        if (!ts.isExportAssignment(declStatement) || declStatement.isExportEquals) continue; // `export =` is CommonJS-style, not a default export
        if (!ts.isArrayLiteralExpression(declStatement.expression)) continue;
        return {
          declarationFile: resolvedPath,
          declarationStart: declStatement.getStart(declSource),
          declarationEnd: declStatement.getEnd(),
          evaluated: evaluateArrayItems(declStatement.expression.elements),
        };
      }
      return null; // resolved to a real file, but no `export default [...]` array literal there
    }

    const exportedName = (namedElement!.propertyName ?? namedElement!.name).text;
    for (const declStatement of declSource.statements) {
      if (!ts.isVariableStatement(declStatement)) continue;
      const isExported = declStatement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!isExported) continue;
      for (const decl of declStatement.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === exportedName &&
          decl.initializer &&
          ts.isArrayLiteralExpression(decl.initializer)
        ) {
          const enclosingStatement = findEnclosingStatement(decl);
          return {
            declarationFile: resolvedPath,
            declarationStart: enclosingStatement.getStart(declSource),
            declarationEnd: enclosingStatement.getEnd(),
            evaluated: evaluateArrayItems(decl.initializer.elements),
          };
        }
      }
    }
    return null; // resolved to a real file, but no matching exported array literal there
  }
  return null; // not bound by any import (local const, namespace import, etc.)
}

/**
 * Finds every `const X = [ {...}, {...} ]` that's later used as
 * `X.map(...)` in `sourceText` — plus, when `X` isn't declared locally,
 * one hop through a plain named import back to wherever it's actually
 * declared (see resolveImportedArrayDeclaration). Arrays never referenced
 * via `.map()` are ignored entirely (not every array in a page is
 * content). Arrays that ARE mapped but whose items aren't plain literal
 * objects are reported as `unanalyzable` rather than guessed at.
 */
export async function findRepeatingContent(
  sourceText: string,
  filePath: string,
  options: { pathAliases?: Record<string, string>; projectRoot?: string } = {},
): Promise<AnalyzeSourceResult> {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const repeatingContent: RepeatingContentCandidate[] = [];
  const unanalyzable: UnanalyzableArrayCandidate[] = [];

  const mappedIdentifiers = new Map<string, number>(); // variable name -> start offset of its first `.map(` call
  const visitForMapUsage = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
      if (ts.isIdentifier(node.expression.expression) && !mappedIdentifiers.has(node.expression.expression.text)) {
        mappedIdentifiers.set(node.expression.expression.text, node.getStart(source));
      }
    }
    ts.forEachChild(node, visitForMapUsage);
  };
  visitForMapUsage(source);

  const locallyDeclared = new Set<string>();
  const visitForDeclarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const variableName = node.name.text;
      if (mappedIdentifiers.has(variableName)) {
        locallyDeclared.add(variableName);
        const evaluated = evaluateArrayItems(node.initializer.elements);
        if ("error" in evaluated) {
          unanalyzable.push({ variableName, sourceFile: filePath, declarationFile: filePath, reason: evaluated.error });
        } else {
          const statement = findEnclosingStatement(node);
          repeatingContent.push({
            variableName,
            sourceFile: filePath,
            declarationFile: filePath,
            items: evaluated.items,
            declarationStart: statement.getStart(source),
            declarationEnd: statement.getEnd(),
            mapCallStart: mappedIdentifiers.get(variableName)!,
          });
        }
      }
    }
    ts.forEachChild(node, visitForDeclarations);
  };
  visitForDeclarations(source);

  for (const [variableName, mapCallStart] of mappedIdentifiers) {
    if (locallyDeclared.has(variableName)) continue;
    const resolved = await resolveImportedArrayDeclaration(source, variableName, filePath, options);
    if (!resolved) continue;
    const { declarationFile, declarationStart, declarationEnd, evaluated } = resolved;
    if ("error" in evaluated) {
      unanalyzable.push({ variableName, sourceFile: filePath, declarationFile, reason: evaluated.error });
      continue;
    }
    repeatingContent.push({
      variableName,
      sourceFile: filePath,
      declarationFile,
      items: evaluated.items,
      declarationStart,
      declarationEnd,
      mapCallStart,
    });
  }

  return { repeatingContent, unanalyzable };
}

const JSX_TAG_DENYLIST = new Set(["Fragment"]);

/**
 * Finds capitalized (component-convention) JSX tags used anywhere in the
 * file and resolves each to its import's source file on disk, following
 * relative imports and the optional path-alias map (e.g. tsconfig's
 * `"@/*": ["./src/*"]`). Tags imported from a package (non-relative,
 * non-aliased specifier) resolve to `sourceFile: null`.
 */
export async function findJsxSections(
  sourceText: string,
  filePath: string,
  options: { pathAliases?: Record<string, string>; projectRoot?: string } = {},
): Promise<JsxSectionCandidate[]> {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const tagNames = new Set<string>();
  const visit = (node: ts.Node): void => {
    let tagName: string | undefined;
    if (ts.isJsxSelfClosingElement(node) && ts.isIdentifier(node.tagName)) tagName = node.tagName.text;
    if (ts.isJsxOpeningElement(node) && ts.isIdentifier(node.tagName)) tagName = node.tagName.text;
    if (tagName && /^[A-Z]/.test(tagName) && !JSX_TAG_DENYLIST.has(tagName)) tagNames.add(tagName);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const importedFrom = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const { importClause } = statement;
    if (importClause.name) importedFrom.set(importClause.name.text, specifier);
    if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const el of importClause.namedBindings.elements) {
        importedFrom.set(el.name.text, specifier);
      }
    }
  }

  const projectRoot = options.projectRoot ?? path.dirname(filePath);
  const results: JsxSectionCandidate[] = [];
  for (const componentName of tagNames) {
    const specifier = importedFrom.get(componentName);
    const resolved = specifier
      ? await resolveModuleSpecifier(specifier, filePath, projectRoot, options.pathAliases ?? {})
      : null;
    results.push({ componentName, sourceFile: resolved });
  }
  return results;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Same four extensions discover-pages.ts recognizes for page files — a plain-JavaScript App Router project (.jsx/.js, no tsconfig.json) resolves imports through here too. */
async function resolveOnDisk(basePath: string): Promise<string | null> {
  const candidates = [
    `${basePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.jsx`,
    `${basePath}.js`,
    `${basePath}/index.tsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.jsx`,
    `${basePath}/index.js`,
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/** Specifiers carrying their own extension (`.json` data imports, chiefly) resolve to that exact file rather than through resolveOnDisk's extension-guessing — appending ".tsx" etc. onto an already-extensioned path would never match. */
const EXPLICIT_EXTENSIONS = [".json", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

async function resolveExplicitOrOnDisk(basePath: string): Promise<string | null> {
  if (EXPLICIT_EXTENSIONS.some((ext) => basePath.endsWith(ext))) {
    return (await fileExists(basePath)) ? basePath : null;
  }
  return resolveOnDisk(basePath);
}

async function resolveModuleSpecifier(
  specifier: string,
  fromFile: string,
  projectRoot: string,
  pathAliases: Record<string, string>,
): Promise<string | null> {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveExplicitOrOnDisk(path.resolve(path.dirname(fromFile), specifier));
  }
  for (const [aliasPattern, target] of Object.entries(pathAliases)) {
    // Only the common single-wildcard form ("@/*" -> "./src/*") is supported.
    if (!aliasPattern.endsWith("/*") || !target.endsWith("/*")) continue;
    const prefix = aliasPattern.slice(0, -1);
    if (!specifier.startsWith(prefix)) continue;
    const rest = specifier.slice(prefix.length);
    const targetBase = target.slice(0, -1);
    // Aliases resolve relative to the project root (tsconfig's location), not the importing file.
    return resolveExplicitOrOnDisk(path.resolve(projectRoot, targetBase, rest));
  }
  return null;
}

/** Convenience wrapper: reads `filePath` off disk and runs {@link findRepeatingContent}. */
export async function findRepeatingContentInFile(filePath: string): Promise<AnalyzeSourceResult> {
  const text = await readFile(filePath, "utf8");
  return findRepeatingContent(text, filePath);
}
