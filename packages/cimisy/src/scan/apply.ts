import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { humanizeLabel, insertCollectionIntoConfig, scaffoldConfigFile } from "../codegen/insert-collection-config.js";
import { rewriteArraySource } from "../codegen/rewrite-array-source.js";
import { collection } from "../config/collection.js";
import type { NormalizedCollection } from "../config/define-config.js";
import { fields } from "../config/fields/index.js";
import type { FieldDefinition } from "../config/fields/types.js";
import { writeEntry } from "../content/collection-store.js";
import { entryPathForSlug } from "../shared/slug.js";
import { LocalStorageAdapter } from "../storage/local.js";
import type { LiteralValue } from "./analyze-source.js";
import { detectSource, pathExists } from "./config-detection.js";
import type { CollectionSchemaProposal, FieldProposal } from "./infer-schema.js";
import type { CollectionCandidateReport } from "./report.js";

export interface ApplyCandidateOptions {
  candidate: CollectionCandidateReport;
  /** Absolute path to cimisy.config.ts — created from the README quickstart template if it doesn't exist yet. */
  configFilePath: string;
  collectionName: string;
  collectionLabel: string;
  /** e.g. "news/*.mdx" */
  contentPath: string;
}

export interface ApplyItemResult {
  index: number;
  slug?: string;
  filePath?: string;
  error?: string;
}

export interface ApplyCandidateResult {
  collectionName: string;
  configFilePath: string;
  configFileCreated: boolean;
  items: ApplyItemResult[];
  rewrittenSourceFile: string;
}

function buildRuntimeField(field: FieldProposal, collectionName: string): FieldDefinition {
  const label = humanizeLabel(field.name);
  switch (field.proposedKind) {
    case "text":
      return fields.text({ label });
    case "image":
      return fields.image({ label, directory: `public/images/${collectionName}` });
    case "array-of-text":
      return fields.array(fields.text({ label }));
  }
}

function buildRuntimeSchema(proposal: CollectionSchemaProposal, collectionName: string): Record<string, FieldDefinition> {
  const schema: Record<string, FieldDefinition> = {
    [proposal.slugField]: fields.slug({ source: proposal.slugSourceField }),
  };
  for (const field of proposal.fields) {
    schema[field.name] = buildRuntimeField(field, collectionName);
  }
  return schema;
}

/**
 * Coerces a scanned literal value into what the proposed field's zod
 * schema expects. Every cimisy text-shaped field requires a defined
 * string (empty is fine, undefined isn't) — so a genuinely missing
 * optional value gets an empty placeholder here rather than being
 * omitted, and any per-item failure that still slips through (e.g. an
 * empty "date") is caught and reported per-item by applyCandidate, never
 * allowed to abort the whole import.
 */
function coerceValue(rawValue: LiteralValue | undefined, field: FieldProposal): unknown {
  if (rawValue === undefined || rawValue === null) {
    if (field.proposedKind === "array-of-text") return [];
    if (field.proposedKind === "image") return null;
    return "";
  }
  if (field.proposedKind === "array-of-text") {
    return Array.isArray(rawValue) ? rawValue.map((el) => (typeof el === "string" ? el : String(el))) : [String(rawValue)];
  }
  return typeof rawValue === "string" ? rawValue : String(rawValue);
}

/**
 * Applies one selected scan candidate: inserts its collection into
 * cimisy.config.ts (scaffolding the file if it doesn't exist yet), writes
 * every item as a real .mdx file via cimisy's own writeEntry — the exact
 * same serialization/validation path the admin UI itself uses, so
 * extracted content is exactly as valid as anything written through the
 * UI — and rewrites the source file to fetch from cimisy instead of the
 * hardcoded array. Local-adapter targets only: refuses clearly if the
 * config uses githubSource rather than attempting something unsafe.
 */
export async function applyCandidate(options: ApplyCandidateOptions): Promise<ApplyCandidateResult> {
  const { candidate, configFilePath, collectionName, collectionLabel, contentPath } = options;

  const configExisted = await pathExists(configFilePath);
  const configText = configExisted ? await readFile(configFilePath, "utf8") : scaffoldConfigFile();

  const detection = configExisted ? detectSource(configText, configFilePath) : { kind: "local" as const, rootDir: "./content" };
  if (detection.kind === "github") {
    throw new Error(
      "cimisy.config.ts uses githubSource — \"cimisy import\" only supports collections stored via localSource for now.",
    );
  }
  if (detection.kind === "unknown") {
    throw new Error(
      "Could not determine cimisy.config.ts's storage adapter (expected a localSource({ rootDir }) call) — refusing to guess where content should be written.",
    );
  }

  const updatedConfigText = insertCollectionIntoConfig(configText, {
    name: collectionName,
    label: collectionLabel,
    path: contentPath,
    proposal: candidate.proposal,
  });
  await mkdir(path.dirname(configFilePath), { recursive: true });
  await writeFile(configFilePath, updatedConfigText, "utf8");

  const rootDir = path.resolve(path.dirname(configFilePath), detection.rootDir);
  const adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });
  const schema = buildRuntimeSchema(candidate.proposal, collectionName);
  const collectionDef = collection({
    label: collectionLabel,
    path: contentPath,
    slugField: candidate.proposal.slugField,
    schema,
  });
  // writeEntry consumes the normalized shape; a scan import is always a
  // top-level collection with an explicit path, so this is a direct lift.
  const def: NormalizedCollection = {
    key: collectionName,
    label: collectionDef.label,
    path: collectionDef.path!,
    directory: collectionDef.directory!,
    extension: collectionDef.extension!,
    slugField: collectionDef.slugField,
    schema: collectionDef.schema,
    previewPath: collectionDef.previewPath,
  };

  const items: ApplyItemResult[] = [];
  for (const [index, item] of candidate.items.entries()) {
    const values: Record<string, unknown> = {
      [candidate.proposal.slugSourceField]: item[candidate.proposal.slugSourceField],
    };
    for (const field of candidate.proposal.fields) {
      values[field.name] = coerceValue(item[field.name], field);
    }
    try {
      const { slug } = await writeEntry(adapter, def, {
        values,
        baseVersion: null,
        author: { name: "cimisy import", email: "cimisy-import@localhost", id: "cimisy-import" },
        message: `Import ${collectionName} entry via cimisy scan`,
        ref: "main",
      });
      items.push({ index, slug, filePath: path.join(rootDir, entryPathForSlug(contentPath, slug)) });
    } catch (err) {
      items.push({ index, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const sourceText = await readFile(candidate.sourceFile, "utf8");
  const rewritten = rewriteArraySource({
    sourceText,
    filePath: candidate.sourceFile,
    configFilePath,
    variableName: candidate.variableName,
    collectionName,
    fields: candidate.proposal.fields,
    declarationStart: candidate.declarationStart,
    declarationEnd: candidate.declarationEnd,
    mapCallStart: candidate.mapCallStart,
  });
  await writeFile(candidate.sourceFile, rewritten, "utf8");

  return {
    collectionName,
    configFilePath,
    configFileCreated: !configExisted,
    items,
    rewrittenSourceFile: candidate.sourceFile,
  };
}
