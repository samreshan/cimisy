import { access, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type LiteralValue = string | number | boolean | null | LiteralValue[];

export interface RepeatingContentCandidate {
  variableName: string;
  sourceFile: string;
  items: Array<Record<string, LiteralValue>>;
  /** Char offsets of the whole `const X = [...]` statement in sourceFile's text, for the later codemod's deletion. */
  declarationStart: number;
  declarationEnd: number;
  /**
   * Char offset of the `X.map(` call expression that consumes this array.
   * The array declaration and its `.map()` usage are often in different
   * scopes (e.g. a module-scope array consumed inside a component
   * function) — the codemod needs THIS position, not declarationStart, to
   * find the right function to make async and to insert an awaited fetch
   * into (a top-level `await` at the declaration's own scope would often
   * be outside any function at all).
   */
  mapCallStart: number;
}

export interface UnanalyzableArrayCandidate {
  variableName: string;
  sourceFile: string;
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

/**
 * Finds every `const X = [ {...}, {...} ]` in `sourceText` that is later
 * used as `X.map(...)` in the same file. Arrays never referenced via
 * `.map()` are ignored entirely (not every array in a page is content).
 * Arrays that ARE mapped but whose items aren't plain literal objects are
 * reported as `unanalyzable` rather than guessed at.
 */
export function findRepeatingContent(sourceText: string, filePath: string): AnalyzeSourceResult {
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

  const visitForDeclarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const variableName = node.name.text;
      if (mappedIdentifiers.has(variableName)) {
        const items: Array<Record<string, LiteralValue>> = [];
        let failureReason: string | null = null;
        for (const [index, element] of node.initializer.elements.entries()) {
          if (!ts.isObjectLiteralExpression(element)) {
            failureReason = `item ${index} is not an object literal`;
            break;
          }
          const result = objectLiteralToRecord(element);
          if ("error" in result) {
            failureReason = `item ${index}: ${result.error}`;
            break;
          }
          items.push(result);
        }

        if (failureReason) {
          unanalyzable.push({ variableName, sourceFile: filePath, reason: failureReason });
        } else if (items.length > 0) {
          const statement = findEnclosingStatement(node);
          repeatingContent.push({
            variableName,
            sourceFile: filePath,
            items,
            declarationStart: statement.getStart(source),
            declarationEnd: statement.getEnd(),
            mapCallStart: mappedIdentifiers.get(variableName)!,
          });
        } else {
          unanalyzable.push({ variableName, sourceFile: filePath, reason: "array is empty, nothing to infer a schema from" });
        }
      }
    }
    ts.forEachChild(node, visitForDeclarations);
  };
  visitForDeclarations(source);

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

async function resolveOnDisk(basePath: string): Promise<string | null> {
  const candidates = [`${basePath}.tsx`, `${basePath}.ts`, `${basePath}/index.tsx`, `${basePath}/index.ts`];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function resolveModuleSpecifier(
  specifier: string,
  fromFile: string,
  projectRoot: string,
  pathAliases: Record<string, string>,
): Promise<string | null> {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveOnDisk(path.resolve(path.dirname(fromFile), specifier));
  }
  for (const [aliasPattern, target] of Object.entries(pathAliases)) {
    // Only the common single-wildcard form ("@/*" -> "./src/*") is supported.
    if (!aliasPattern.endsWith("/*") || !target.endsWith("/*")) continue;
    const prefix = aliasPattern.slice(0, -1);
    if (!specifier.startsWith(prefix)) continue;
    const rest = specifier.slice(prefix.length);
    const targetBase = target.slice(0, -1);
    // Aliases resolve relative to the project root (tsconfig's location), not the importing file.
    return resolveOnDisk(path.resolve(projectRoot, targetBase, rest));
  }
  return null;
}

/** Convenience wrapper: reads `filePath` off disk and runs {@link findRepeatingContent}. */
export async function findRepeatingContentInFile(filePath: string): Promise<AnalyzeSourceResult> {
  const text = await readFile(filePath, "utf8");
  return findRepeatingContent(text, filePath);
}
