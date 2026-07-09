import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findJsxSections, findRepeatingContent, type LiteralValue } from "./analyze-source.js";
import { discoverPages } from "./discover-pages.js";
import { inferSchema, type CollectionSchemaProposal } from "./infer-schema.js";

export interface CollectionCandidateReport {
  variableName: string;
  sourceFile: string;
  /** The JSX section (component name) that owns this array, or "page" if it's declared directly in a page file. */
  section: string;
  itemCount: number;
  proposal: CollectionSchemaProposal;
  items: Array<Record<string, LiteralValue>>;
  /** Char offsets of the array's `const X = [...]` statement in sourceFile, for the Milestone B codemod. */
  declarationStart: number;
  declarationEnd: number;
  /** Char offset of the `X.map(` call that consumes this array — see analyze-source.ts's RepeatingContentCandidate. */
  mapCallStart: number;
  /** Routes that render this candidate, directly or via a shared component (e.g. a Navbar array appears on every route that renders <Navbar/>). */
  usedOnRoutes: string[];
}

export interface UnanalyzableReport {
  variableName: string;
  sourceFile: string;
  section: string;
  reason: string;
  usedOnRoutes: string[];
}

export interface PageSummary {
  pagePath: string;
  routePath: string;
}

export interface ScanReport {
  generatedAt: string;
  appDir: string;
  pages: PageSummary[];
  /** Deduplicated by (sourceFile, variableName) across the whole app — a shared component's array is reported once, not once per page. */
  collectionCandidates: CollectionCandidateReport[];
  unanalyzable: UnanalyzableReport[];
}

export interface RunScanOptions {
  appDir: string;
  projectRoot: string;
  pathAliases?: Record<string, string>;
}

function deriveRoutePath(pagePath: string, appDir: string): string {
  const rel = path.relative(appDir, path.dirname(pagePath));
  if (!rel || rel === ".") return "/";
  const segments = rel.split(path.sep).filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export async function runScan(options: RunScanOptions): Promise<ScanReport> {
  const pagePaths = await discoverPages({ appDir: options.appDir });
  const pages: PageSummary[] = [];

  const candidatesByKey = new Map<string, CollectionCandidateReport>();
  const unanalyzableByKey = new Map<string, UnanalyzableReport>();
  const fileTextCache = new Map<string, string>();

  const readCached = async (file: string): Promise<string> => {
    const cached = fileTextCache.get(file);
    if (cached !== undefined) return cached;
    const text = await readFile(file, "utf8");
    fileTextCache.set(file, text);
    return text;
  };

  for (const pagePath of pagePaths) {
    const pageText = await readCached(pagePath);
    const routePath = deriveRoutePath(pagePath, options.appDir);
    pages.push({ pagePath, routePath });

    const sections = await findJsxSections(pageText, pagePath, {
      projectRoot: options.projectRoot,
      pathAliases: options.pathAliases,
    });

    const filesToScan = new Map<string, string>(); // sourceFile -> section label
    filesToScan.set(pagePath, "page");
    for (const section of sections) {
      if (section.sourceFile) filesToScan.set(section.sourceFile, section.componentName);
    }

    for (const [file, sectionLabel] of filesToScan) {
      const text = await readCached(file);
      const result = findRepeatingContent(text, file);

      for (const candidate of result.repeatingContent) {
        const key = `${candidate.sourceFile}::${candidate.variableName}`;
        const existing = candidatesByKey.get(key);
        if (existing) {
          if (!existing.usedOnRoutes.includes(routePath)) existing.usedOnRoutes.push(routePath);
          continue;
        }
        candidatesByKey.set(key, {
          variableName: candidate.variableName,
          sourceFile: candidate.sourceFile,
          section: sectionLabel,
          itemCount: candidate.items.length,
          proposal: inferSchema(candidate.items),
          items: candidate.items,
          declarationStart: candidate.declarationStart,
          declarationEnd: candidate.declarationEnd,
          mapCallStart: candidate.mapCallStart,
          usedOnRoutes: [routePath],
        });
      }
      for (const candidate of result.unanalyzable) {
        const key = `${candidate.sourceFile}::${candidate.variableName}`;
        const existing = unanalyzableByKey.get(key);
        if (existing) {
          if (!existing.usedOnRoutes.includes(routePath)) existing.usedOnRoutes.push(routePath);
          continue;
        }
        unanalyzableByKey.set(key, { ...candidate, section: sectionLabel, usedOnRoutes: [routePath] });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    appDir: options.appDir,
    pages,
    collectionCandidates: [...candidatesByKey.values()],
    unanalyzable: [...unanalyzableByKey.values()],
  };
}

function formatRoutes(routes: string[]): string {
  return routes.length <= 3 ? routes.join(", ") : `${routes.slice(0, 3).join(", ")}, +${routes.length - 3} more`;
}

export function printScanReport(report: ScanReport): string {
  if (report.collectionCandidates.length === 0 && report.unanalyzable.length === 0) {
    return "No repetitive content candidates found.";
  }

  const lines: string[] = [];

  if (report.collectionCandidates.length > 0) {
    lines.push("Collection candidates:");
    for (const candidate of report.collectionCandidates) {
      const rel = path.relative(report.appDir, candidate.sourceFile);
      lines.push(
        `  [${candidate.section}] ${candidate.variableName}  (${rel})  — ${candidate.itemCount} items, used on ${formatRoutes(candidate.usedOnRoutes)}`,
      );
      for (const field of candidate.proposal.fields) {
        const flags = [field.optional ? "optional" : null, field.note ?? null].filter(Boolean).join("; ");
        lines.push(`      ${field.name}: ${field.proposedKind}${flags ? `  (${flags})` : ""}`);
      }
    }
  }

  if (report.unanalyzable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Detected but not import-eligible:");
    for (const item of report.unanalyzable) {
      const rel = path.relative(report.appDir, item.sourceFile);
      lines.push(`  [${item.section}] ${item.variableName}  (${rel})  — ${item.reason}  (used on ${formatRoutes(item.usedOnRoutes)})`);
    }
  }

  return lines.join("\n");
}

export function defaultReportPath(projectRoot: string): string {
  return path.join(projectRoot, ".cimisy", "scan-report.json");
}

export async function saveScanReport(report: ScanReport, filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function loadScanReport(filePath: string): Promise<ScanReport> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as ScanReport;
}
