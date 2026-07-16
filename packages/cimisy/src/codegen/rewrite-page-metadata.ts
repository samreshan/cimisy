import { ensureNamedImport } from "./insert-collection-config.js";
import {
  applyEdits,
  ensureDefaultImport,
  isTypeScriptFile,
  lineIndentBefore,
  propertyAccess,
  toImportSpecifier,
} from "./source-edit-utils.js";

export interface RewritePageMetadataOptions {
  sourceText: string;
  /** Absolute path of the page file being rewritten. */
  filePath: string;
  /** Absolute path of cimisy.config.ts. */
  configFilePath: string;
  /** The page's config key — the generated code reads `cimisyReader.pages.<pageKey>.seo`. */
  pageKey: string;
  /** The page's route, passed to createMetadata as the canonical fallback. */
  routePath: string;
  /** Char span of the `export const metadata = {...}` statement in sourceText — must be freshly derived from THIS text (see apply-page-metadata.ts), never from a cached scan report. */
  nodeStart: number;
  nodeEnd: number;
}

/**
 * Replaces a page's static `export const metadata = {...}` statement with an
 * async `generateMetadata()` that reads the migrated SEO section back through
 * the Reader and rebuilds the Metadata object via cimisy/seo's
 * createMetadata(). Deliberately emits no `Metadata` return-type annotation
 * and no `import type { Metadata }` — inference produces the same type, and
 * type-only imports are a minefield across `verbatimModuleSyntax`
 * configurations (ensureNamedImport can only emit value imports). The
 * `SeoValue` cast is inline (`import("cimisy/config").SeoValue`) for the same
 * reason, and TS-only — plain .js/.jsx files get no cast at all.
 */
export function rewritePageMetadata(options: RewritePageMetadataOptions): string {
  const { sourceText, filePath, configFilePath, pageKey, routePath, nodeStart, nodeEnd } = options;

  const indent = lineIndentBefore(sourceText, nodeStart);
  const inner = `${indent}  `;
  const isTs = isTypeScriptFile(filePath);
  const cast = isTs ? ` as { seo?: import("cimisy/config").SeoValue } | undefined` : "";
  // PageReader types sections as `CollectionReader | SingletonReader` (see
  // next/reader.ts), so a TS file needs the SingletonReader assertion for
  // `.get()` to typecheck — same inline-`import()` form as the values cast.
  const seoSectionAccess = isTs
    ? `(${propertyAccess("cimisyReader.pages", pageKey)}.seo as import("cimisy/next").SingletonReader)`
    : `${propertyAccess("cimisyReader.pages", pageKey)}.seo`;
  const replacement = [
    `export async function generateMetadata() {`,
    `${inner}const cimisyReader = createReader(cimisyConfig);`,
    `${inner}const content = (await ${seoSectionAccess}.get())?.values${cast};`,
    `${inner}return createMetadata({ seo: content?.seo, path: ${JSON.stringify(routePath)} });`,
    `${indent}}`,
  ].join("\n");

  const replaced = applyEdits(sourceText, [{ start: nodeStart, end: nodeEnd, text: replacement }]);

  let result = ensureNamedImport(replaced, "cimisy/next", ["createReader"]);
  result = ensureNamedImport(result, "cimisy/seo", ["createMetadata"]);
  result = ensureDefaultImport(result, toImportSpecifier(filePath, configFilePath), "cimisyConfig");
  return result;
}
