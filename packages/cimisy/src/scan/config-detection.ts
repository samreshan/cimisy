import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type SourceDetection = { kind: "local"; rootDir: string } | { kind: "github" } | { kind: "unknown" };

/**
 * Statically inspects cimisy.config.ts's `source:` expression rather than
 * executing the (arbitrary TS) config file — apply-time codemods only
 * support localSource targets, so a syntactic check for `localSource({ rootDir })`
 * vs `githubSource(...)` is enough, and avoids needing a TS runtime loader
 * inside the CLI.
 */
export function detectSource(configText: string, configFilePath: string): SourceDetection {
  const source = ts.createSourceFile(configFilePath, configText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let detection: SourceDetection = { kind: "unknown" };
  const visit = (node: ts.Node): void => {
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
