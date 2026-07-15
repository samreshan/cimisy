import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

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
