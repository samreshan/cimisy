import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { insertSectionIntoPageConfig, resolveExistingPagePath } from "../codegen/insert-static-content-config.js";
import { rewritePageMetadata } from "../codegen/rewrite-page-metadata.js";
import { scaffoldConfigFile } from "../codegen/insert-collection-config.js";
import { computeSectionPath, type NormalizedSingleton } from "../config/define-config.js";
import { fields } from "../config/fields/index.js";
import type { SeoValue } from "../config/fields/seo.js";
import { writeSingleton } from "../content/singleton-store.js";
import { LocalStorageAdapter } from "../storage/local.js";
import { findPageMetadata } from "./analyze-page-metadata.js";
import { detectSource, pathExists } from "./config-detection.js";
import type { StaticSchemaProposal } from "./infer-static-schema.js";
import type { PageMetadataCandidateReport } from "./report.js";

export interface ApplyPageMetadataOptions {
  candidate: PageMetadataCandidateReport;
  /** Absolute path to cimisy.config.ts — created from the README quickstart template if it doesn't exist yet. */
  configFilePath: string;
}

export interface ApplyPageMetadataResult {
  /** The section's config key, e.g. "about.seo". */
  key: string;
  configFilePath: string;
  configFileCreated: boolean;
  filePath?: string;
  error?: string;
  rewrittenSourceFile: string;
}

/** The fixed section key page metadata migrates into — `pages.<pageKey>.seo`. */
const SEO_SECTION_KEY = "seo";

/**
 * Applies one selected page-metadata scan candidate: inserts a
 * `seo: section({ schema: { seo: fields.seo() } })` under the page's config
 * entry, writes the extracted title/description/canonical as that section's
 * YAML via writeSingleton (the same validation path the admin uses — the seo
 * zod schema is the authoritative gate, e.g. an `http://` canonical fails
 * here with a clear error instead of being silently mangled), then replaces
 * the page's `export const metadata` with a `generateMetadata()` that reads
 * it back. Mirrors apply-static-content.ts: localSource targets only, config
 * before content, content before the source rewrite.
 */
export async function applyPageMetadataCandidate(options: ApplyPageMetadataOptions): Promise<ApplyPageMetadataResult> {
  const { candidate, configFilePath } = options;
  const pageKey = candidate.pageKey;
  if (!pageKey) {
    throw new Error(
      "This scan report predates metadata import (no pageKey on the candidate) — re-run \"cimisy scan\" and try again.",
    );
  }

  const configExisted = await pathExists(configFilePath);
  const configText = configExisted ? await readFile(configFilePath, "utf8") : scaffoldConfigFile();

  const detection = configExisted ? detectSource(configText, configFilePath) : { kind: "local" as const, rootDir: "./content" };
  if (detection.kind === "github") {
    throw new Error(
      `${path.basename(configFilePath)} uses githubSource — "cimisy import" only supports content stored via localSource for now.`,
    );
  }
  if (detection.kind === "unknown") {
    throw new Error(
      `Could not determine ${path.basename(configFilePath)}'s storage adapter (expected a localSource({ rootDir }) call) — refusing to guess where content should be written.`,
    );
  }

  const seoValue: SeoValue = {};
  if (candidate.title !== undefined) seoValue.title = candidate.title;
  if (candidate.description !== undefined) seoValue.description = candidate.description;
  if (candidate.canonical !== undefined) seoValue.canonical = candidate.canonical;

  const sectionKeyPath = `${pageKey}.${SEO_SECTION_KEY}`;
  const proposal: StaticSchemaProposal = {
    fields: [{ name: "seo", label: "SEO", proposedKind: "seo", initialValue: seoValue }],
    format: "yaml",
    fieldAssignments: [],
  };

  const pagePath = configExisted ? (resolveExistingPagePath(configText, pageKey) ?? `pages/${pageKey}`) : `pages/${pageKey}`;
  const relPath = computeSectionPath(pagePath, SEO_SECTION_KEY, "yaml");
  const def: NormalizedSingleton = {
    key: sectionKeyPath,
    label: "SEO",
    path: relPath,
    format: "yaml",
    schema: { seo: fields.seo() },
    previewPath: candidate.routePath,
  };

  const updatedConfigText = insertSectionIntoPageConfig(configText, {
    pageKey,
    pageLabel: candidate.pageLabel ?? pageKey,
    pageRoute: candidate.routePath,
    pagePath,
    sectionKey: SEO_SECTION_KEY,
    sectionLabel: "SEO",
    proposal,
  });

  await mkdir(path.dirname(configFilePath), { recursive: true });
  await writeFile(configFilePath, updatedConfigText, "utf8");

  const rootDir = path.resolve(path.dirname(configFilePath), detection.rootDir);
  const adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });

  let filePath: string | undefined;
  let error: string | undefined;
  try {
    await writeSingleton(adapter, def, {
      values: { seo: seoValue },
      baseVersion: null,
      author: { name: "cimisy import", email: "cimisy-import@localhost", id: "cimisy-import" },
      message: `Import ${sectionKeyPath} via cimisy scan`,
      ref: "main",
    });
    filePath = path.join(rootDir, def.path);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Re-derive the statement span from the file as it exists NOW — an earlier
  // candidate applied in this same import run may have edited this page file
  // and shifted every cached offset (same posture as apply-static-content.ts).
  // A page has at most one `export const metadata`, so the first fresh
  // candidate is unambiguous.
  const sourceText = await readFile(candidate.sourceFile, "utf8");
  const fresh = findPageMetadata(sourceText, candidate.sourceFile).metadata[0];
  if (!fresh) {
    throw new Error(
      `Could not find an importable "export const metadata" in ${candidate.sourceFile} anymore — it may have been altered since the scan. Re-run "cimisy scan" and try again.`,
    );
  }
  const rewritten = rewritePageMetadata({
    sourceText,
    filePath: candidate.sourceFile,
    configFilePath,
    pageKey,
    routePath: candidate.routePath,
    nodeStart: fresh.nodeStart,
    nodeEnd: fresh.nodeEnd,
  });
  await writeFile(candidate.sourceFile, rewritten, "utf8");

  return {
    key: sectionKeyPath,
    configFilePath,
    configFileCreated: !configExisted,
    filePath,
    error,
    rewrittenSourceFile: candidate.sourceFile,
  };
}
