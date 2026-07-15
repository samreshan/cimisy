import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { insertSectionIntoPageConfig, insertSingletonIntoConfig, resolveExistingPagePath } from "../codegen/insert-static-content-config.js";
import { rewriteStaticContentSource, type ReaderPath } from "../codegen/rewrite-static-content-source.js";
import { scaffoldConfigFile } from "../codegen/insert-collection-config.js";
import { computeSectionPath, type NormalizedSingleton } from "../config/define-config.js";
import { blocks, fields } from "../config/fields/index.js";
import type { FieldDefinition } from "../config/fields/types.js";
import { writeSingleton } from "../content/singleton-store.js";
import { LocalStorageAdapter } from "../storage/local.js";
import { findStaticContent } from "./analyze-static-content.js";
import { detectSource, pathExists } from "./config-detection.js";
import type { StaticFieldProposal } from "./infer-static-schema.js";
import type { StaticContentCandidateReport } from "./report.js";

export interface ApplyStaticCandidateOptions {
  candidate: StaticContentCandidateReport;
  /** Absolute path to cimisy.config.ts — created from the README quickstart template if it doesn't exist yet. */
  configFilePath: string;
}

export interface ApplyStaticCandidateResult {
  key: string;
  configFilePath: string;
  configFileCreated: boolean;
  filePath?: string;
  error?: string;
  rewrittenSourceFile: string;
}

function buildRuntimeField(field: StaticFieldProposal, contentKey: string): FieldDefinition {
  switch (field.proposedKind) {
    case "text":
      return fields.text({ label: field.label });
    case "image":
      return fields.image({ label: field.label, directory: `public/images/${contentKey}` });
    case "blocks":
      return fields.blocks({ label: field.label, blocks: { paragraph: blocks.paragraph() } });
  }
}

function buildRuntimeSchema(proposalFields: StaticFieldProposal[], contentKey: string): Record<string, FieldDefinition> {
  const schema: Record<string, FieldDefinition> = {};
  for (const field of proposalFields) schema[field.name] = buildRuntimeField(field, contentKey);
  return schema;
}

/** e.g. "home.hero" -> "heroContent", "footer" -> "footerContent" — always a valid JS identifier even if the key's last segment is numeric-leading. */
function toVariableName(key: string): string {
  const lastSegment = key.split(".").pop()!;
  const camel = lastSegment.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const safe = /^[0-9]/.test(camel) ? `field${camel}` : camel;
  return `${safe}Content`;
}

/**
 * Applies one selected static-content scan candidate: writes its
 * singleton/section entry via cimisy's own writeSingleton (the exact same
 * serialization/validation path the admin UI itself uses), inserts the
 * corresponding `singleton({...})`/`page({...}){ sections }` into
 * cimisy.config.ts, and rewrites the source file to read from
 * `reader.singletons.<key>` / `reader.pages.<pageKey>.<sectionKey>` instead
 * of the hardcoded JSX. Mirrors scan/apply.ts's applyCandidate: local-
 * adapter targets only (refuses githubSource), config is written before
 * content, content before the source rewrite — so a mid-way failure never
 * leaves the source rewritten ahead of the data it depends on.
 */
export async function applyStaticCandidate(options: ApplyStaticCandidateOptions): Promise<ApplyStaticCandidateResult> {
  const { candidate, configFilePath } = options;

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

  const { proposal } = candidate;
  const contentKeyForImages = candidate.proposedKey.replace(/\./g, "-");
  const schema = buildRuntimeSchema(proposal.fields, contentKeyForImages);
  const values: Record<string, unknown> = {};
  for (const field of proposal.fields) values[field.name] = field.initialValue;

  let def: NormalizedSingleton;
  let updatedConfigText: string;
  let readerPath: ReaderPath;

  if (candidate.scope === "top-level-singleton") {
    const key = candidate.proposedKey;
    // Bare, rootDir-relative — matches the bare (no "content/" prefix) paths cimisy import already uses for collections, so both conventions resolve consistently under the same rootDir.
    const relPath = `${key}${proposal.format === "yaml" ? ".yaml" : ".mdx"}`;
    def = { key, label: candidate.proposedLabel, path: relPath, format: proposal.format, schema };
    readerPath = { kind: "singleton", key };
    updatedConfigText = insertSingletonIntoConfig(configText, {
      name: key,
      label: candidate.proposedLabel,
      path: relPath,
      proposal,
    });
  } else {
    const pageKey = candidate.pageKey!;
    const sectionKey = candidate.proposedKey.split(".").pop()!;
    const pagePath = configExisted ? (resolveExistingPagePath(configText, pageKey) ?? `pages/${pageKey}`) : `pages/${pageKey}`;
    const relPath = computeSectionPath(pagePath, sectionKey, proposal.format);
    def = { key: candidate.proposedKey, label: candidate.proposedLabel, path: relPath, format: proposal.format, schema, previewPath: candidate.pageRoute };
    readerPath = { kind: "page-section", pageKey, sectionKey };
    updatedConfigText = insertSectionIntoPageConfig(configText, {
      pageKey,
      pageLabel: candidate.pageLabel!,
      pageRoute: candidate.pageRoute,
      pagePath,
      sectionKey,
      sectionLabel: candidate.proposedLabel,
      proposal,
    });
  }

  await mkdir(path.dirname(configFilePath), { recursive: true });
  await writeFile(configFilePath, updatedConfigText, "utf8");

  const rootDir = path.resolve(path.dirname(configFilePath), detection.rootDir);
  const adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });

  let filePath: string | undefined;
  let error: string | undefined;
  try {
    await writeSingleton(adapter, def, {
      values,
      baseVersion: null,
      author: { name: "cimisy import", email: "cimisy-import@localhost", id: "cimisy-import" },
      message: `Import ${candidate.proposedKey} via cimisy scan --full`,
      ref: "main",
    });
    filePath = path.join(rootDir, def.path);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const sourceText = await readFile(candidate.sourceFile, "utf8");
  // Re-derive this region's byte offsets from the text just read, rather than trusting candidate.fields/regionStart —
  // those were captured at scan time, and a prior candidate applied earlier in the same "cimisy import" run may
  // have already edited this same file, shifting every offset after its edit. regionHint (an id/className token or
  // component name) is stable across that edit — it never depends on byte position — so it's what re-identifies
  // this region in the fresh scan. The field VALUES (and therefore `proposal`, which only encodes those) can't have
  // changed either, since a correctly-scoped earlier edit only touches OTHER regions, never this one.
  const freshRegion = findStaticContent(sourceText, candidate.sourceFile).staticContent.find(
    (region) => region.regionHint === candidate.regionHint,
  );
  if (!freshRegion) {
    throw new Error(
      `Could not find region "${candidate.regionHint}" in ${candidate.sourceFile} anymore — it may have been altered by an earlier candidate applied in this same run. Re-run "cimisy scan --full" and try again.`,
    );
  }
  if (freshRegion.fields.length !== proposal.fieldAssignments.length) {
    throw new Error(
      `Region "${candidate.regionHint}" in ${candidate.sourceFile} no longer has the same fields it did when scanned (found ${freshRegion.fields.length}, expected ${proposal.fieldAssignments.length}) — re-run "cimisy scan --full" and try again.`,
    );
  }
  const rewritten = rewriteStaticContentSource({
    sourceText,
    filePath: candidate.sourceFile,
    configFilePath,
    variableName: toVariableName(candidate.proposedKey),
    readerPath,
    fields: freshRegion.fields,
    fieldAssignments: proposal.fieldAssignments,
    proposalFields: proposal.fields,
    anchorPos: freshRegion.regionStart,
  });
  await writeFile(candidate.sourceFile, rewritten, "utf8");

  return {
    key: candidate.proposedKey,
    configFilePath,
    configFileCreated: !configExisted,
    filePath,
    error,
    rewrittenSourceFile: candidate.sourceFile,
  };
}
