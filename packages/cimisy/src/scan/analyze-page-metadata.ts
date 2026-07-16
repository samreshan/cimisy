import ts from "typescript";

export interface PageMetadataCandidate {
  sourceFile: string;
  title?: string;
  description?: string;
  /** Sourced from `openGraph.url` — createMetadata() (see seo/metadata.ts) derives openGraph.url FROM fields.seo()'s `canonical`, so a hand-written page's `openGraph.url` is exactly the value that round-trips back into that field. */
  canonical?: string;
  /** Char offsets of the whole `export const metadata = {...}` statement in sourceText, for a future codemod. */
  nodeStart: number;
  nodeEnd: number;
}

export interface UnanalyzableMetadataCandidate {
  sourceFile: string;
  reason: string;
  nodeStart: number;
  nodeEnd: number;
}

export interface PageMetadataAnalysisResult {
  metadata: PageMetadataCandidate[];
  unanalyzable: UnanalyzableMetadataCandidate[];
}

function stringLiteralValue(expr: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(expr) ? expr.text : undefined;
}

function findProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return obj.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
  );
}

/** The only top-level metadata properties fields.seo() can represent — anything else present makes the object non-importable (a codemod would silently drop it). */
const REPRESENTABLE_TOP_LEVEL_PROPS = new Set(["title", "description", "openGraph"]);
/** Inside openGraph: `url` maps to canonical; `title`/`description` are tolerated only when they duplicate the top level (createMetadata regenerates them from it — see seo/metadata.ts). */
const REPRESENTABLE_OPEN_GRAPH_PROPS = new Set(["url", "title", "description"]);

function propNameText(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!prop.name) return undefined;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) return prop.name.text;
  return undefined;
}

/** The first property of `obj` that fields.seo() can't store (unknown name, spread, computed key, shorthand) — or undefined when everything is representable. */
function findUnrepresentableProp(obj: ts.ObjectLiteralExpression, allowed: Set<string>): string | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) return ts.isSpreadAssignment(prop) ? "...spread" : (propNameText(prop) ?? "<computed>");
    const name = propNameText(prop);
    if (name === undefined || !allowed.has(name)) return name ?? "<computed>";
  }
  return undefined;
}

/** `x satisfies Metadata` (and parenthesized wrappers) → the inner expression. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Finds a top-level `export const metadata = {...}` object literal — Next.js
 * App Router's per-page SEO convention — and extracts the subset of fields
 * cimisy's fields.seo() can actually store: `title`, `description`, and
 * `canonical` (read from a literal `openGraph.url`, not a top-level
 * `alternates.canonical` — see PageMetadataCandidate.canonical for why).
 * Mirrors findStaticContent's "detect but don't guess" posture, hardened for
 * the import codemod (which *deletes* the statement it migrates):
 * - any property fields.seo() can't store (keywords, robots, openGraph.images, …)
 *   makes the whole object unanalyzable — migrating would silently drop it;
 * - a non-object-literal initializer (identifier, call, …) is reported, not skipped;
 * - an existing `generateMetadata` export is reported as already-dynamic;
 * - `satisfies Metadata` / `as Metadata` wrappers are unwrapped, not rejected.
 */
export function findPageMetadata(sourceText: string, filePath: string): PageMetadataAnalysisResult {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const metadata: PageMetadataCandidate[] = [];
  const unanalyzable: UnanalyzableMetadataCandidate[] = [];

  for (const statement of source.statements) {
    const generateMetadataSpan = exportedGenerateMetadataSpan(statement, source);
    if (generateMetadataSpan) {
      unanalyzable.push({
        sourceFile: filePath,
        reason: "page already exports generateMetadata() — its metadata is dynamic and can't be statically migrated",
        nodeStart: generateMetadataSpan.nodeStart,
        nodeEnd: generateMetadataSpan.nodeEnd,
      });
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!isExported) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "metadata") continue;
      const nodeStart = statement.getStart(source);
      const nodeEnd = statement.getEnd();
      const initializer = decl.initializer ? unwrapExpression(decl.initializer) : undefined;
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        unanalyzable.push({
          sourceFile: filePath,
          reason: "metadata is not a plain object literal (computed or imported values can't be statically migrated)",
          nodeStart,
          nodeEnd,
        });
        continue;
      }
      const obj = initializer;

      const unrepresentable = findUnrepresentableProp(obj, REPRESENTABLE_TOP_LEVEL_PROPS);
      if (unrepresentable !== undefined) {
        unanalyzable.push({
          sourceFile: filePath,
          reason: `metadata has properties fields.seo() can't store ("${unrepresentable}") — migrating would silently drop them`,
          nodeStart,
          nodeEnd,
        });
        continue;
      }

      const titleProp = findProp(obj, "title");
      if (titleProp && !ts.isStringLiteralLike(titleProp.initializer)) {
        unanalyzable.push({ sourceFile: filePath, reason: `"title" is not a plain string literal`, nodeStart, nodeEnd });
        continue;
      }
      const descriptionProp = findProp(obj, "description");
      if (descriptionProp && !ts.isStringLiteralLike(descriptionProp.initializer)) {
        unanalyzable.push({ sourceFile: filePath, reason: `"description" is not a plain string literal`, nodeStart, nodeEnd });
        continue;
      }

      const title = titleProp ? stringLiteralValue(titleProp.initializer) : undefined;
      const description = descriptionProp ? stringLiteralValue(descriptionProp.initializer) : undefined;

      let canonical: string | undefined;
      const ogProp = findProp(obj, "openGraph");
      if (ogProp) {
        if (!ts.isObjectLiteralExpression(ogProp.initializer)) {
          unanalyzable.push({ sourceFile: filePath, reason: `"openGraph" is not a plain object literal`, nodeStart, nodeEnd });
          continue;
        }
        const ogUnrepresentable = findUnrepresentableProp(ogProp.initializer, REPRESENTABLE_OPEN_GRAPH_PROPS);
        if (ogUnrepresentable !== undefined) {
          unanalyzable.push({
            sourceFile: filePath,
            reason: `metadata has properties fields.seo() can't store ("openGraph.${ogUnrepresentable}") — migrating would silently drop them`,
            nodeStart,
            nodeEnd,
          });
          continue;
        }
        const urlProp = findProp(ogProp.initializer, "url");
        if (urlProp) {
          if (!ts.isStringLiteralLike(urlProp.initializer)) {
            unanalyzable.push({ sourceFile: filePath, reason: `"openGraph.url" is not a plain string literal`, nodeStart, nodeEnd });
            continue;
          }
          canonical = stringLiteralValue(urlProp.initializer);
        }
        // createMetadata() regenerates og:title/og:description from the top-level
        // values, so a divergent hand-written pair would not round-trip.
        const divergent = ["title", "description"].find((name) => {
          const prop = findProp(ogProp.initializer as ts.ObjectLiteralExpression, name);
          if (!prop) return false;
          const topLevel = name === "title" ? title : description;
          return !ts.isStringLiteralLike(prop.initializer) || prop.initializer.text !== topLevel;
        });
        if (divergent) {
          unanalyzable.push({
            sourceFile: filePath,
            reason: `"openGraph.${divergent}" differs from the top-level ${divergent} — fields.seo() stores one value for both, so migrating would change the page's Open Graph output`,
            nodeStart,
            nodeEnd,
          });
          continue;
        }
      }

      if (title === undefined && description === undefined && canonical === undefined) {
        unanalyzable.push({
          sourceFile: filePath,
          reason: "metadata object has no title, description, or openGraph.url to extract",
          nodeStart,
          nodeEnd,
        });
        continue;
      }

      metadata.push({ sourceFile: filePath, title, description, canonical, nodeStart, nodeEnd });
    }
  }

  return { metadata, unanalyzable };
}

/** The span of an exported `generateMetadata` declaration (`export async function generateMetadata` or `export const generateMetadata = ...`), or null when this statement isn't one. */
function exportedGenerateMetadataSpan(
  statement: ts.Statement,
  source: ts.SourceFile,
): { nodeStart: number; nodeEnd: number } | null {
  const isExported = ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false;
  if (!isExported) return null;
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === "generateMetadata") {
    return { nodeStart: statement.getStart(source), nodeEnd: statement.getEnd() };
  }
  if (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "generateMetadata")
  ) {
    return { nodeStart: statement.getStart(source), nodeEnd: statement.getEnd() };
  }
  return null;
}
