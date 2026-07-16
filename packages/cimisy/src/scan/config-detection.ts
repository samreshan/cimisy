import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { isScanMode, type ScanMode } from "./modes.js";

export type SourceDetection = { kind: "local"; rootDir: string } | { kind: "github" } | { kind: "unknown" };

/** `process.env.NODE_ENV` accessed via plain dot notation — the only shape the README's own recommended switch uses. */
function isNodeEnvAccess(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "NODE_ENV" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "env" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process"
  );
}

/**
 * Recognizes `process.env.NODE_ENV === "development"` (either operand
 * order, `===`/`!==`/`==`/`!=`) and evaluates it against the CLI's own
 * actual `process.env.NODE_ENV` — the same variable the config would
 * branch on once actually loaded by the app. Returns null for any
 * condition it doesn't recognize, so the caller can refuse to guess
 * rather than default to picking a branch.
 */
function evaluateNodeEnvCondition(expr: ts.Expression): boolean | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const negated =
    expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  const isComparison =
    negated ||
    expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
  if (!isComparison) return null;

  let literalSide: ts.Expression | null = null;
  if (isNodeEnvAccess(expr.left)) literalSide = expr.right;
  else if (isNodeEnvAccess(expr.right)) literalSide = expr.left;
  if (!literalSide || !ts.isStringLiteralLike(literalSide)) return null;

  const matches = process.env.NODE_ENV === literalSide.text;
  return negated ? !matches : matches;
}

/**
 * Statically inspects cimisy.config.ts's `source:` expression rather than
 * executing the (arbitrary TS) config file — apply-time codemods only
 * support localSource targets, so a syntactic check for `localSource({ rootDir })`
 * vs `githubSource(...)` is enough, and avoids needing a TS runtime loader
 * inside the CLI. A plain top-level call is unambiguous; a ternary keyed on
 * `process.env.NODE_ENV` (the README's own recommended local/production
 * switch) is evaluated against the CLI's real NODE_ENV so only the branch
 * that would actually run is inspected — walking both branches and letting
 * whichever is textually last "win" (the previous behavior) picked
 * `githubSource` unconditionally, since it's always the `: ` branch in the
 * documented shape, regardless of the real NODE_ENV. A conditional keyed on
 * anything else is skipped entirely rather than guessed at.
 */
export function detectSource(configText: string, configFilePath: string): SourceDetection {
  const source = ts.createSourceFile(configFilePath, configText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let detection: SourceDetection = { kind: "unknown" };
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node)) {
      const branch = evaluateNodeEnvCondition(node.condition);
      if (branch !== null) {
        visit(branch ? node.whenTrue : node.whenFalse);
        return;
      }
      return; // an unrecognized condition — don't guess which branch would run
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "githubSource") {
        detection = { kind: "github" };
        return;
      }
      if (node.expression.text === "localSource" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const prop of node.arguments[0].properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "rootDir" &&
            ts.isStringLiteralLike(prop.initializer)
          ) {
            detection = { kind: "local", rootDir: prop.initializer.text };
          }
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return detection;
}

export interface ScanConfigDetection {
  mode?: ScanMode;
  exclude?: string[];
  /** Human-readable notes about `scan` values that were present but couldn't be read statically — the caller prints them so a silently-ignored config isn't mysterious. */
  warnings: string[];
}

/**
 * Statically reads the config's optional `scan: { mode, exclude }` key —
 * same never-execute-arbitrary-TS posture as detectSource above. Only
 * plain literals count: a computed `mode` (ternary, variable, function
 * call) is reported as a warning and ignored rather than guessed at.
 */
export function detectScanConfig(configText: string, configFilePath: string): ScanConfigDetection {
  const source = ts.createSourceFile(configFilePath, configText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const configFileName = path.basename(configFilePath);
  const detection: ScanConfigDetection = { warnings: [] };

  const configObj = findConfigCallObjectArgument(source);
  if (!configObj) return detection;

  const scanProp = configObj.properties.find(
    (prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop) && propertyName(prop) === "scan",
  );
  if (!scanProp) return detection;
  if (!ts.isObjectLiteralExpression(scanProp.initializer)) {
    detection.warnings.push(`scan in ${configFileName} is not a plain object literal — ignoring it.`);
    return detection;
  }

  for (const prop of scanProp.initializer.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyName(prop);
    if (name === "mode") {
      if (ts.isStringLiteralLike(prop.initializer) && isScanMode(prop.initializer.text)) {
        detection.mode = prop.initializer.text;
      } else {
        detection.warnings.push(
          `scan.mode in ${configFileName} is not one of the known mode string literals — falling back to the default.`,
        );
      }
      continue;
    }
    if (name === "exclude") {
      if (
        ts.isArrayLiteralExpression(prop.initializer) &&
        prop.initializer.elements.every((el) => ts.isStringLiteralLike(el))
      ) {
        detection.exclude = prop.initializer.elements.map((el) => (el as ts.StringLiteralLike).text);
      } else {
        detection.warnings.push(`scan.exclude in ${configFileName} is not an array of string literals — ignoring it.`);
      }
    }
  }
  return detection;
}

function propertyName(prop: ts.PropertyAssignment): string | null {
  if (ts.isIdentifier(prop.name)) return prop.name.text;
  if (ts.isStringLiteralLike(prop.name)) return prop.name.text;
  return null;
}

/** The `config({...})` call's first-argument object literal — same shape codegen/insert-static-content-config.ts locates when inserting config. */
function findConfigCallObjectArgument(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "config" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      found = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await readFile(candidate, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Every extension a hand-authored cimisy.config might use — .ts first since that's the README quickstart's own default, but a plain-JavaScript project (no tsconfig.json) commonly has .js or .mjs instead. */
const CONFIG_FILE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/**
 * Finds the project's actual cimisy.config.* file, trying each recognized
 * extension in turn — apply-time codemods must edit the config that's
 * really there (e.g. a hand-authored cimisy.config.js with existing
 * collections), not a hardcoded ".ts" guess that would silently scaffold a
 * competing, empty file alongside it. Falls back to the conventional
 * "cimisy.config.ts" path (which doesn't exist on disk yet) when none of
 * the extensions are found, for callers that scaffold a fresh file there.
 */
export async function resolveConfigFilePath(projectRoot: string): Promise<string> {
  for (const ext of CONFIG_FILE_EXTENSIONS) {
    const candidate = path.join(projectRoot, `cimisy.config${ext}`);
    if (await pathExists(candidate)) return candidate;
  }
  return path.join(projectRoot, "cimisy.config.ts");
}
