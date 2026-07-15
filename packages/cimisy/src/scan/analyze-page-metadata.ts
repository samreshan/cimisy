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

/**
 * Finds a top-level `export const metadata = {...}` object literal — Next.js
 * App Router's per-page SEO convention — and extracts the subset of fields
 * cimisy's fields.seo() can actually store: `title`, `description`, and
 * `canonical` (read from a literal `openGraph.url`, not a top-level
 * `alternates.canonical` — see PageMetadataCandidate.canonical for why).
 * Mirrors findStaticContent's "detect but don't guess" posture: any of the
 * three fields that isn't a plain string literal makes the whole object
 * unanalyzable rather than silently dropped.
 */
export function findPageMetadata(sourceText: string, filePath: string): PageMetadataAnalysisResult {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const metadata: PageMetadataCandidate[] = [];
  const unanalyzable: UnanalyzableMetadataCandidate[] = [];

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!isExported) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "metadata") continue;
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      const obj = decl.initializer;
      const nodeStart = statement.getStart(source);
      const nodeEnd = statement.getEnd();

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

      let canonical: string | undefined;
      const ogProp = findProp(obj, "openGraph");
      if (ogProp) {
        if (!ts.isObjectLiteralExpression(ogProp.initializer)) {
          unanalyzable.push({ sourceFile: filePath, reason: `"openGraph" is not a plain object literal`, nodeStart, nodeEnd });
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
      }

      const title = titleProp ? stringLiteralValue(titleProp.initializer) : undefined;
      const description = descriptionProp ? stringLiteralValue(descriptionProp.initializer) : undefined;

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
