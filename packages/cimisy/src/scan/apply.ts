import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { humanizeLabel, insertCollectionIntoConfig, scaffoldConfigFile } from "../codegen/insert-collection-config.js";
import { deleteArrayDeclaration, rewriteArraySource } from "../codegen/rewrite-array-source.js";
import { collection } from "../config/collection.js";
import type { NormalizedCollection } from "../config/define-config.js";
import { fields } from "../config/fields/index.js";
import type { FieldDefinition } from "../config/fields/types.js";
import { writeEntry } from "../content/collection-store.js";
import { entryPathForSlug } from "../shared/slug.js";
import { LocalStorageAdapter } from "../storage/local.js";
import { relocateMapUsage, type LiteralValue } from "./analyze-source.js";
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
  /** Present only when the candidate's array lived in a different module than its `.map()` call (declarationFile !== sourceFile) — that module's now-unused declaration was deleted here too. */
  rewrittenDeclarationFile?: string;
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
      `${path.basename(configFilePath)} uses githubSource — "cimisy import" only supports collections stored via localSource for now.`,
    );
  }
  if (detection.kind === "unknown") {
    throw new Error(
      `Could not determine ${path.basename(configFilePath)}'s storage adapter (expected a localSource({ rootDir }) call) — refusing to guess where content should be written.`,
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

  // The array's declaration and its .map() usage are usually the same file (declarationFile === sourceFile) —
  // but when the array was factored into its own data module, they're not (see analyze-source.ts's
  // RepeatingContentCandidate.declarationFile); that module's declaration is then deleted separately below.
  const isCrossFile = candidate.declarationFile !== candidate.sourceFile;

  const sourceText = await readFile(candidate.sourceFile, "utf8");
  // Re-derive mapCallStart (and, for the same-file case, the declaration's own span) from the text just
  // read, rather than trusting candidate.mapCallStart/declarationStart/declarationEnd — those were captured
  // at scan time, and a prior candidate applied earlier in the same "cimisy import" run may have already
  // edited this same file (deleted a different array's declaration, inserted a fetch), shifting every offset
  // after its edit. Using stale offsets here doesn't just fail loudly — it splices text at the wrong byte
  // range, silently corrupting the file. variableName is stable across that edit, so it's what re-locates
  // this candidate's own `.map()` call (and local declaration) in the fresh text.
  const relocated = relocateMapUsage(sourceText, candidate.sourceFile, candidate.variableName);
  if (!relocated) {
    throw new Error(
      `Could not find "${candidate.variableName}.map(...)" in ${candidate.sourceFile} anymore — it may have been altered by an earlier candidate applied in this same run. Re-run "cimisy scan" and try again.`,
    );
  }
  if (!isCrossFile && !relocated.localDeclaration) {
    throw new Error(
      `Could not find "${candidate.variableName}"'s own declaration in ${candidate.sourceFile} anymore — it may have been altered by an earlier candidate applied in this same run. Re-run "cimisy scan" and try again.`,
    );
  }
  const rewritten = rewriteArraySource({
    sourceText,
    filePath: candidate.sourceFile,
    configFilePath,
    variableName: candidate.variableName,
    collectionName,
    fields: candidate.proposal.fields,
    mapCallStart: relocated.mapCallStart,
    ...(isCrossFile ? {} : relocated.localDeclaration!),
  });
  await writeFile(candidate.sourceFile, rewritten, "utf8");

  // Note: declarationStart/declarationEnd here are NOT re-derived the way sourceFile's offsets above are —
  // unlike variableName (stable across an edit), the array's *exported* name in declarationFile isn't
  // reliably recoverable from the candidate alone (an aliased import, `import { leaders as team }`, means
  // variableName ("team") differs from what's actually declared there ("leaders")). This is safe for the
  // common case (each candidate's declarationFile is only ever touched once per run), but two DIFFERENT
  // candidates sharing one data module (e.g. two arrays both exported from the same leadership.js) can still
  // go stale the same way sourceFile's offsets used to — a known gap, not yet fixed.
  let rewrittenDeclarationFile: string | undefined;
  if (isCrossFile) {
    if (candidate.declarationFile.endsWith(".json")) {
      // A `.json` data module's entire content IS the array (analyze-source.ts's JSON
      // resolution only ever matches a root-level array) — text-splicing declarationStart..End
      // would leave an empty, invalid JSON file behind instead of removing the now-dead import target.
      await unlink(candidate.declarationFile);
    } else {
      const declarationText = await readFile(candidate.declarationFile, "utf8");
      const rewrittenDeclaration = deleteArrayDeclaration(declarationText, candidate.declarationStart, candidate.declarationEnd);
      await writeFile(candidate.declarationFile, rewrittenDeclaration, "utf8");
    }
    rewrittenDeclarationFile = candidate.declarationFile;
  }

  return {
    collectionName,
    configFilePath,
    configFileCreated: !configExisted,
    items,
    rewrittenSourceFile: candidate.sourceFile,
    ...(rewrittenDeclarationFile ? { rewrittenDeclarationFile } : {}),
  };
}
