import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { humanizeLabel } from "../codegen/insert-collection-config.js";
import { findJsxSections, findRepeatingContent, type LiteralValue } from "./analyze-source.js";
import { findStaticContent, type StaticFieldCandidate } from "./analyze-static-content.js";
import { discoverPages } from "./discover-pages.js";
import { inferSchema, type CollectionSchemaProposal } from "./infer-schema.js";
import { assertKeyAllowed, deriveKey, inferStaticSchema, type StaticSchemaProposal } from "./infer-static-schema.js";

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

export interface StaticContentCandidateReport {
  /** Raw hint from analyze-static-content.ts (id/className token or component name) — kept for traceability alongside the derived proposedKey. */
  regionHint: string;
  sourceFile: string;
  /** The JSX section (component name) that owns this region, or "page" — same convention as CollectionCandidateReport.section. */
  section: string;
  /** "page-section" when the region renders on exactly one route (nests under that route's page); "top-level-singleton" when the owning file renders on multiple routes (e.g. a shared Footer). */
  scope: "page-section" | "top-level-singleton";
  /** Final config key — "home.hero" for a page-section, or a bare top-level key like "footer" for a singleton. */
  proposedKey: string;
  proposedLabel: string;
  /** Present only when scope === "page-section". */
  pageKey?: string;
  pageLabel?: string;
  pageRoute?: string;
  proposal: StaticSchemaProposal;
  fields: StaticFieldCandidate[];
  regionStart: number;
  regionEnd: number;
  usedOnRoutes: string[];
}

export interface StaticUnanalyzableReport {
  sourceFile: string;
  regionHint: string;
  section: string;
  reason: string;
  nodeStart: number;
  nodeEnd: number;
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
  /** Only populated when RunScanOptions.full is true — always present (possibly empty) once a report has been produced by runScan, so the JSON shape is stable regardless of which mode produced it. Optional here only so hand-built ScanReport-shaped test fixtures predating --full still typecheck. */
  staticContentCandidates?: StaticContentCandidateReport[];
  staticUnanalyzable?: StaticUnanalyzableReport[];
}

export interface RunScanOptions {
  appDir: string;
  projectRoot: string;
  pathAliases?: Record<string, string>;
  /** Also scan for static, non-repeating content (headings/paragraphs/images/links) and propose it as sections/singletons. Defaults to false — a plain `cimisy scan` only looks for repeating .map()'d arrays, unchanged from before this option existed. */
  full?: boolean;
}

/** "/" -> "home", "/about" -> "about", "/about/team" -> "about/team" (deriveKey's slugify collapses the "/" to "-"). */
function pageKeyHintForRoute(route: string): string {
  return route === "/" ? "home" : route.replace(/^\//, "");
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
  interface RawStaticRegion {
    sourceFile: string;
    regionHint: string;
    section: string;
    regionStart: number;
    regionEnd: number;
    fields: StaticFieldCandidate[];
    usedOnRoutes: string[];
  }
  const staticByKey = new Map<string, RawStaticRegion>();
  const staticUnanalyzableByKey = new Map<string, StaticUnanalyzableReport>();
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

      if (options.full) {
        const staticResult = findStaticContent(text, file);
        for (const region of staticResult.staticContent) {
          const key = `${region.sourceFile}::${region.regionHint}`;
          const existing = staticByKey.get(key);
          if (existing) {
            if (!existing.usedOnRoutes.includes(routePath)) existing.usedOnRoutes.push(routePath);
            continue;
          }
          staticByKey.set(key, {
            sourceFile: region.sourceFile,
            regionHint: region.regionHint,
            section: sectionLabel,
            regionStart: region.regionStart,
            regionEnd: region.regionEnd,
            fields: region.fields,
            usedOnRoutes: [routePath],
          });
        }
        for (const item of staticResult.unanalyzable) {
          // nodeStart disambiguates multiple distinct unanalyzable nodes sharing one regionHint (e.g. two mixed-expression headings in the same <section>).
          const key = `${item.sourceFile}::${item.regionHint}::${item.nodeStart}`;
          const existing = staticUnanalyzableByKey.get(key);
          if (existing) {
            if (!existing.usedOnRoutes.includes(routePath)) existing.usedOnRoutes.push(routePath);
            continue;
          }
          staticUnanalyzableByKey.set(key, { ...item, section: sectionLabel, usedOnRoutes: [routePath] });
        }
      }
    }
  }

  const staticContentCandidates: StaticContentCandidateReport[] = [];
  const staticUnanalyzable: StaticUnanalyzableReport[] = [...staticUnanalyzableByKey.values()];

  if (options.full) {
    // Best-effort seed only — the authoritative collision check against the
    // real, live cimisy.config.ts happens at apply time (insertSingletonIntoConfig/
    // insertSectionIntoPageConfig); this just avoids obviously colliding with
    // a collection name proposed in the same scan run.
    const existingTopLevelKeys = new Set([...candidatesByKey.values()].map((c) => c.variableName));
    const pageKeyByRoute = new Map<string, string>();
    const sectionKeysByPage = new Map<string, Set<string>>();

    for (const region of staticByKey.values()) {
      try {
        const proposal = inferStaticSchema({
          sourceFile: region.sourceFile,
          regionHint: region.regionHint,
          regionStart: region.regionStart,
          regionEnd: region.regionEnd,
          fields: region.fields,
        });

        if (region.usedOnRoutes.length > 1) {
          const proposedKey = deriveKey(region.regionHint, existingTopLevelKeys);
          assertKeyAllowed(proposedKey);
          staticContentCandidates.push({
            regionHint: region.regionHint,
            sourceFile: region.sourceFile,
            section: region.section,
            scope: "top-level-singleton",
            proposedKey,
            proposedLabel: humanizeLabel(proposedKey),
            proposal,
            fields: region.fields,
            regionStart: region.regionStart,
            regionEnd: region.regionEnd,
            usedOnRoutes: region.usedOnRoutes,
          });
          continue;
        }

        const route = region.usedOnRoutes[0]!;
        let pageKey = pageKeyByRoute.get(route);
        if (!pageKey) {
          pageKey = deriveKey(pageKeyHintForRoute(route), existingTopLevelKeys);
          pageKeyByRoute.set(route, pageKey);
          sectionKeysByPage.set(pageKey, new Set());
        }
        const sectionKeys = sectionKeysByPage.get(pageKey)!;
        const sectionKey = deriveKey(region.regionHint, sectionKeys);
        const proposedKey = `${pageKey}.${sectionKey}`;
        assertKeyAllowed(proposedKey);

        staticContentCandidates.push({
          regionHint: region.regionHint,
          sourceFile: region.sourceFile,
          section: region.section,
          scope: "page-section",
          proposedKey,
          proposedLabel: humanizeLabel(sectionKey),
          pageKey,
          pageLabel: humanizeLabel(pageKeyHintForRoute(route)),
          pageRoute: route,
          proposal,
          fields: region.fields,
          regionStart: region.regionStart,
          regionEnd: region.regionEnd,
          usedOnRoutes: region.usedOnRoutes,
        });
      } catch (err) {
        staticUnanalyzable.push({
          sourceFile: region.sourceFile,
          regionHint: region.regionHint,
          section: region.section,
          reason: err instanceof Error ? err.message : String(err),
          nodeStart: region.regionStart,
          nodeEnd: region.regionEnd,
          usedOnRoutes: region.usedOnRoutes,
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    appDir: options.appDir,
    pages,
    collectionCandidates: [...candidatesByKey.values()],
    unanalyzable: [...unanalyzableByKey.values()],
    staticContentCandidates,
    staticUnanalyzable,
  };
}

function formatRoutes(routes: string[]): string {
  return routes.length <= 3 ? routes.join(", ") : `${routes.slice(0, 3).join(", ")}, +${routes.length - 3} more`;
}

export function printScanReport(report: ScanReport): string {
  const staticContentCandidates = report.staticContentCandidates ?? [];
  const staticUnanalyzable = report.staticUnanalyzable ?? [];

  if (
    report.collectionCandidates.length === 0 &&
    report.unanalyzable.length === 0 &&
    staticContentCandidates.length === 0 &&
    staticUnanalyzable.length === 0
  ) {
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

  if (staticContentCandidates.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Static content candidates:");
    for (const candidate of staticContentCandidates) {
      const rel = path.relative(report.appDir, candidate.sourceFile);
      const scopeLabel = candidate.scope === "top-level-singleton" ? "singleton" : "section";
      lines.push(
        `  [${candidate.section}] ${candidate.proposedKey}  (${scopeLabel}, ${rel})  — ${candidate.fields.length} field(s), used on ${formatRoutes(candidate.usedOnRoutes)}`,
      );
      for (const field of candidate.proposal.fields) {
        lines.push(`      ${field.name}: ${field.proposedKind}`);
      }
    }
  }

  if (staticUnanalyzable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Detected but not import-eligible (static content):");
    for (const item of staticUnanalyzable) {
      const rel = path.relative(report.appDir, item.sourceFile);
      lines.push(`  [${item.section}] ${item.regionHint}  (${rel})  — ${item.reason}  (used on ${formatRoutes(item.usedOnRoutes)})`);
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
