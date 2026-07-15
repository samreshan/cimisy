import ts from "typescript";

/**
 * Next.js's Client Component marker: a bare string-literal expression
 * statement (`"use client";` / `'use client';`) as the very first statement
 * in the file — the ECMAScript "directive prologue" convention Next.js
 * repurposes for this. `createReader` (cimisy/next) imports the `server-only`
 * package, so it can never be injected into a file carrying this directive —
 * doing so is a hard runtime crash ("'server-only' cannot be imported from a
 * Client Component module"), and even setting that aside, React doesn't
 * support async Client Components at all, which every codegen path here also
 * needs to make its rewritten component.
 */
export function hasUseClientDirective(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteralLike(first.expression) && first.expression.text === "use client";
}

export const USE_CLIENT_UNANALYZABLE_REASON =
  "this file is a Client Component (\"use client\") — cimisy import doesn't rewrite Client Components yet, since createReader is server-only and React doesn't support async Client Components. Wire the fetch manually, or split this into a Server Component wrapper that fetches the data and passes it down as a prop.";
