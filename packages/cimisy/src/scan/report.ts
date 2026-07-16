import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { humanizeLabel } from "../codegen/insert-collection-config.js";
import { findPageMetadata } from "./analyze-page-metadata.js";
import { findJsxSections, findRepeatingContent, type LiteralValue } from "./analyze-source.js";
import { findStaticContent, type StaticFieldCandidate } from "./analyze-static-content.js";
import { discoverEntrypoints, type Entrypoint, type EntrypointKind } from "./discover-pages.js";
import { inferSchema, type CollectionSchemaProposal } from "./infer-schema.js";
import { DEFAULT_SCAN_MODE, resolveScanMode, type ScanMode } from "./modes.js";
import { assertKeyAllowed, deriveKey, inferStaticSchema, type StaticSchemaProposal } from "./infer-static-schema.js";

export interface CollectionCandidateReport {
  variableName: string;
  /** The file whose `.map()` call consumes this array. */
  sourceFile: string;
  /** The file the array is actually declared in — see analyze-source.ts's RepeatingContentCandidate.declarationFile. Equal to sourceFile except when the array lives in its own data module. */
  declarationFile: string;
  /** The JSX section (component name) that owns this array, or "page" if it's declared directly in a page file. */
  section: string;
  itemCount: number;
  proposal: CollectionSchemaProposal;
  items: Array<Record<string, LiteralValue>>;
  /** Char offsets of the array's `const X = [...]` statement in declarationFile, for the Milestone B codemod. */
  declarationStart: number;
  declarationEnd: number;
  /** Char offset of the `X.map(` call that consumes this array, in sourceFile — see analyze-source.ts's RepeatingContentCandidate. */
  mapCallStart: number;
  /** Routes that render this candidate, directly or via a shared component (e.g. a Navbar array appears on every route that renders <Navbar/>). */
  usedOnRoutes: string[];
}

export interface UnanalyzableReport {
  variableName: string;
  sourceFile: string;
  declarationFile: string;
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

/** Every scanned analysis root — pages plus layout/template/special files — with the page routes each one spans (a layout's `routes` are its subtree's page routes). */
export interface EntrypointSummary {
  filePath: string;
  kind: EntrypointKind;
  routes: string[];
}

export interface PageMetadataCandidateReport {
  sourceFile: string;
  routePath: string;
  title?: string;
  description?: string;
  canonical?: string;
  nodeStart: number;
  nodeEnd: number;
  /** Config keys this metadata would land under when imported (`pages.<pageKey>.seo`) — derived with the same key maps the static-content block uses, so a page's sections and metadata share one page() entry. */
  pageKey?: string;
  pageLabel?: string;
}

export interface PageMetadataUnanalyzableReport {
  sourceFile: string;
  routePath: string;
  reason: string;
  nodeStart: number;
  nodeEnd: number;
}

export interface ScanReport {
  /** Bumped when the report's shape changes incompatibly; absent on pre-2.3 cached reports. */
  reportVersion?: number;
  /** The scan depth that produced this report (see scan/modes.ts); absent on pre-2.3 cached reports (whose --full maps to "static-metadata"). */
  mode?: ScanMode;
  generatedAt: string;
  appDir: string;
  pages: PageSummary[];
  /** Absent on pre-2.3 cached reports. */
  entrypoints?: EntrypointSummary[];
  /** Deduplicated by (sourceFile, variableName) across the whole app — a shared component's array is reported once, not once per page. */
  collectionCandidates: CollectionCandidateReport[];
  unanalyzable: UnanalyzableReport[];
  /** Only populated when RunScanOptions.full is true — always present (possibly empty) once a report has been produced by runScan, so the JSON shape is stable regardless of which mode produced it. Optional here only so hand-built ScanReport-shaped test fixtures predating --full still typecheck. */
  staticContentCandidates?: StaticContentCandidateReport[];
  staticUnanalyzable?: StaticUnanalyzableReport[];
  /**
   * A page's `export const metadata = {...}` (Next.js App Router's SEO
   * convention) — reporting only for now (see analyze-page-metadata.ts);
   * there's no `cimisy import`-style codemod for these yet, unlike
   * collectionCandidates/staticContentCandidates. Same optionality
   * rationale as staticContentCandidates.
   */
  pageMetadataCandidates?: PageMetadataCandidateReport[];
  pageMetadataUnanalyzable?: PageMetadataUnanalyzableReport[];
}

export interface RunScanOptions {
  appDir: string;
  projectRoot: string;
  pathAliases?: Record<string, string>;
  /** Scan depth — see scan/modes.ts. Defaults to "collections" (repeating .map()'d arrays only, unchanged from before modes existed). */
  mode?: ScanMode;
  /** appDir-relative path prefixes to skip during entrypoint discovery (from cimisy.config's `scan.exclude`). */
  exclude?: string[];
  /** @deprecated pre-2.3 alias for `mode: "static-metadata"`; ignored when `mode` is set. */
  full?: boolean;
}

/**
 * Resolves the full transitive JSX-component-import closure reachable from
 * a route file: a page.tsx that renders <XxxPage/>, which itself renders
 * <SomeGrid/>, which renders <Card/>, etc. — not just the first hop.
 * findJsxSections only looks at the JSX tags/imports of the ONE file it's
 * given, so this BFSes over its results, calling it again on every
 * newly-resolved file until nothing new turns up. `visited` both dedupes
 * and guards against import cycles (A renders B renders A). A file's
 * "section" label is the name of the (possibly deeply-nested) component
 * that actually renders it, not the page's direct child — that's the
 * label that already reads right for the common thin `page.tsx` -> real
 * page component -> individual section components convention.
 */
async function resolveFilesToScan(
  pagePath: string,
  pageText: string,
  options: { pathAliases?: Record<string, string>; projectRoot?: string; rootLabel?: string },
  readCached: (file: string) => Promise<string>,
): Promise<Map<string, string>> {
  const filesToScan = new Map<string, string>([[pagePath, options.rootLabel ?? "page"]]);
  const visited = new Set<string>([pagePath]);
  const queue: Array<{ file: string; text: string }> = [{ file: pagePath, text: pageText }];

  while (queue.length > 0) {
    const { file, text } = queue.shift()!;
    const sections = await findJsxSections(text, file, {
      projectRoot: options.projectRoot,
      pathAliases: options.pathAliases,
    });
    for (const section of sections) {
      if (!section.sourceFile || visited.has(section.sourceFile)) continue;
      visited.add(section.sourceFile);
      filesToScan.set(section.sourceFile, section.componentName);
      queue.push({ file: section.sourceFile, text: await readCached(section.sourceFile) });
    }
  }

  return filesToScan;
}

/** "/" -> "home", "/about" -> "about", "/about/team" -> "about/team" (deriveKey's slugify collapses the "/" to "-"). */
function pageKeyHintForRoute(route: string): string {
  return route === "/" ? "home" : route.replace(/^\//, "");
}

function deriveRoutePath(pagePath: string, appDir: string): string {
  const rel = path.relative(appDir, path.dirname(pagePath));
  if (!rel || rel === ".") return "/";
  // Route groups "(marketing)" and parallel-route slots "@sidebar" both
  // vanish from the URL — only plain segments contribute.
  const segments = rel
    .split(path.sep)
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")) && !seg.startsWith("@"));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * The page routes an entrypoint's content actually shows on. A page is its
 * own route; a layout/template/loading/error spans every page route at or
 * under its own directory; not-found/global-error render outside any one
 * route and span everything. An empty result (e.g. a layout whose subtree
 * has no pages yet) means the entrypoint renders nowhere — callers skip it.
 */
function routesForEntrypoint(entrypoint: Entrypoint, appDir: string, pages: PageSummary[]): string[] {
  if (entrypoint.kind === "page") return [deriveRoutePath(entrypoint.filePath, appDir)];
  if (entrypoint.kind === "not-found" || entrypoint.kind === "global-error") {
    return [...new Set(pages.map((p) => p.routePath))];
  }
  const dir = path.dirname(entrypoint.filePath);
  const routes = pages.filter((p) => p.pagePath.startsWith(`${dir}${path.sep}`)).map((p) => p.routePath);
  return [...new Set(routes)];
}

/** Union `routes` into `target` in-place, preserving first-seen order. */
function mergeRoutes(target: string[], routes: string[]): void {
  for (const route of routes) {
    if (!target.includes(route)) target.push(route);
  }
}

const LAYOUT_METADATA_REASON =
  "layout-level metadata applies to every route below it — migrate it manually into site-wide SEO defaults rather than a per-page fields.seo().";

export async function runScan(options: RunScanOptions): Promise<ScanReport> {
  const mode: ScanMode = options.mode ?? (options.full ? "static-metadata" : DEFAULT_SCAN_MODE);
  const { includeStatic, includeMetadata } = resolveScanMode(mode);

  const entrypoints = await discoverEntrypoints({ appDir: options.appDir, exclude: options.exclude });
  const pages: PageSummary[] = entrypoints
    .filter((e) => e.kind === "page")
    .map((e) => ({ pagePath: e.filePath, routePath: deriveRoutePath(e.filePath, options.appDir) }));

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
    /** Whether any *page* entrypoint's closure reached this region — false means it lives only in layout/template/special files and must always be a top-level singleton, whatever its route count. */
    reachedFromPage: boolean;
  }
  const staticByKey = new Map<string, RawStaticRegion>();
  const staticUnanalyzableByKey = new Map<string, StaticUnanalyzableReport>();
  const pageMetadataCandidates: PageMetadataCandidateReport[] = [];
  const pageMetadataUnanalyzable: PageMetadataUnanalyzableReport[] = [];
  const fileTextCache = new Map<string, string>();
  const entrypointSummaries: EntrypointSummary[] = [];

  const readCached = async (file: string): Promise<string> => {
    const cached = fileTextCache.get(file);
    if (cached !== undefined) return cached;
    const text = await readFile(file, "utf8");
    fileTextCache.set(file, text);
    return text;
  };

  for (const entrypoint of entrypoints) {
    const routes = routesForEntrypoint(entrypoint, options.appDir, pages);
    // A layout/loading/etc. whose subtree has no pages renders nowhere — skip it.
    if (routes.length === 0) continue;
    entrypointSummaries.push({ filePath: entrypoint.filePath, kind: entrypoint.kind, routes });

    const entryText = await readCached(entrypoint.filePath);
    const isPage = entrypoint.kind === "page";

    if (includeMetadata && (isPage || entrypoint.kind === "layout")) {
      // export const metadata is a page/layout-file convention (not a JSX-reachable component
      // concern), so this reads the entrypoint directly rather than joining the closure below.
      // Layout metadata is real but spans the whole subtree — reported, never auto-imported.
      const metadataResult = findPageMetadata(entryText, entrypoint.filePath);
      // A page's metadata belongs to its own route; a layout's belongs to its
      // directory-derived route (e.g. "/" for the root layout), not whichever
      // subtree page happens to sort first.
      const routePath = isPage ? routes[0]! : deriveRoutePath(entrypoint.filePath, options.appDir);
      if (isPage) {
        for (const candidate of metadataResult.metadata) pageMetadataCandidates.push({ ...candidate, routePath });
      } else {
        for (const candidate of metadataResult.metadata) {
          pageMetadataUnanalyzable.push({
            sourceFile: candidate.sourceFile,
            routePath,
            reason: LAYOUT_METADATA_REASON,
            nodeStart: candidate.nodeStart,
            nodeEnd: candidate.nodeEnd,
          });
        }
      }
      for (const item of metadataResult.unanalyzable) pageMetadataUnanalyzable.push({ ...item, routePath });
    }

    const filesToScan = await resolveFilesToScan(
      entrypoint.filePath,
      entryText,
      { projectRoot: options.projectRoot, pathAliases: options.pathAliases, rootLabel: entrypoint.kind },
      readCached,
    );

    for (const [file, sectionLabel] of filesToScan) {
      const text = await readCached(file);
      const result = await findRepeatingContent(text, file, {
        pathAliases: options.pathAliases,
        projectRoot: options.projectRoot,
      });

      for (const candidate of result.repeatingContent) {
        // Keyed by declarationFile (not sourceFile): a data module's array shared by
        // several components (each with its own .map() call/sourceFile) is one candidate.
        const key = `${candidate.declarationFile}::${candidate.variableName}`;
        const existing = candidatesByKey.get(key);
        if (existing) {
          mergeRoutes(existing.usedOnRoutes, routes);
          continue;
        }
        candidatesByKey.set(key, {
          variableName: candidate.variableName,
          sourceFile: candidate.sourceFile,
          declarationFile: candidate.declarationFile,
          section: sectionLabel,
          itemCount: candidate.items.length,
          proposal: inferSchema(candidate.items),
          items: candidate.items,
          declarationStart: candidate.declarationStart,
          declarationEnd: candidate.declarationEnd,
          mapCallStart: candidate.mapCallStart,
          usedOnRoutes: [...routes],
        });
      }
      for (const candidate of result.unanalyzable) {
        const key = `${candidate.declarationFile}::${candidate.variableName}`;
        const existing = unanalyzableByKey.get(key);
        if (existing) {
          mergeRoutes(existing.usedOnRoutes, routes);
          continue;
        }
        unanalyzableByKey.set(key, { ...candidate, section: sectionLabel, usedOnRoutes: [...routes] });
      }

      if (includeStatic) {
        const staticResult = findStaticContent(text, file);
        for (const region of staticResult.staticContent) {
          const key = `${region.sourceFile}::${region.regionHint}`;
          const existing = staticByKey.get(key);
          if (existing) {
            mergeRoutes(existing.usedOnRoutes, routes);
            existing.reachedFromPage ||= isPage;
            continue;
          }
          staticByKey.set(key, {
            sourceFile: region.sourceFile,
            regionHint: region.regionHint,
            section: sectionLabel,
            regionStart: region.regionStart,
            regionEnd: region.regionEnd,
            fields: region.fields,
            usedOnRoutes: [...routes],
            reachedFromPage: isPage,
          });
        }
        for (const item of staticResult.unanalyzable) {
          // nodeStart disambiguates multiple distinct unanalyzable nodes sharing one regionHint (e.g. two mixed-expression headings in the same <section>).
          const key = `${item.sourceFile}::${item.regionHint}::${item.nodeStart}`;
          const existing = staticUnanalyzableByKey.get(key);
          if (existing) {
            mergeRoutes(existing.usedOnRoutes, routes);
            continue;
          }
          staticUnanalyzableByKey.set(key, { ...item, section: sectionLabel, usedOnRoutes: [...routes] });
        }
      }
    }
  }

  const staticContentCandidates: StaticContentCandidateReport[] = [];
  const staticUnanalyzable: StaticUnanalyzableReport[] = [...staticUnanalyzableByKey.values()];

  // Best-effort seed only — the authoritative collision check against the
  // real, live cimisy.config.ts happens at apply time (insertSingletonIntoConfig/
  // insertSectionIntoPageConfig); this just avoids obviously colliding with
  // a collection name proposed in the same scan run. Hoisted above both the
  // static block and the metadata stamping below so a page's sections and
  // its metadata derive the same pageKey.
  const existingTopLevelKeys = new Set([...candidatesByKey.values()].map((c) => c.variableName));
  const pageKeyByRoute = new Map<string, string>();
  const sectionKeysByPage = new Map<string, Set<string>>();
  const pageKeyForRoute = (route: string): string => {
    let pageKey = pageKeyByRoute.get(route);
    if (!pageKey) {
      pageKey = deriveKey(pageKeyHintForRoute(route), existingTopLevelKeys);
      pageKeyByRoute.set(route, pageKey);
      sectionKeysByPage.set(pageKey, new Set());
    }
    return pageKey;
  };

  if (includeStatic) {
    for (const region of staticByKey.values()) {
      try {
        const proposal = inferStaticSchema({
          sourceFile: region.sourceFile,
          regionHint: region.regionHint,
          regionStart: region.regionStart,
          regionEnd: region.regionEnd,
          fields: region.fields,
        });

        // Multi-route content is a shared singleton; so is anything reached
        // only via layout/template/special entrypoints — even on one route,
        // nesting it under that page would orphan it the moment a second
        // page appears in the layout's subtree.
        if (region.usedOnRoutes.length > 1 || !region.reachedFromPage) {
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
        const pageKey = pageKeyForRoute(route);
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

  // Stamp the config keys metadata import will target — after the static
  // block so a page that has both sections and metadata reuses its pageKey.
  for (const candidate of pageMetadataCandidates) {
    candidate.pageKey = pageKeyForRoute(candidate.routePath);
    candidate.pageLabel = humanizeLabel(pageKeyHintForRoute(candidate.routePath));
  }

  return {
    reportVersion: 1,
    mode,
    generatedAt: new Date().toISOString(),
    appDir: options.appDir,
    pages,
    entrypoints: entrypointSummaries,
    collectionCandidates: [...candidatesByKey.values()],
    unanalyzable: [...unanalyzableByKey.values()],
    staticContentCandidates,
    staticUnanalyzable,
    pageMetadataCandidates,
    pageMetadataUnanalyzable,
  };
}

function formatRoutes(routes: string[]): string {
  return routes.length <= 3 ? routes.join(", ") : `${routes.slice(0, 3).join(", ")}, +${routes.length - 3} more`;
}

/** "(news/page.tsx)" for the common same-file case, "(components/Grid.tsx, declared in data/leaders.ts)" when the array's own declaration lives in a different module (see analyze-source.ts's cross-file resolution). */
function formatLocation(appDir: string, sourceFile: string, declarationFile: string): string {
  const rel = path.relative(appDir, sourceFile);
  if (declarationFile === sourceFile) return rel;
  return `${rel}, declared in ${path.relative(appDir, declarationFile)}`;
}

export function printScanReport(report: ScanReport): string {
  const staticContentCandidates = report.staticContentCandidates ?? [];
  const staticUnanalyzable = report.staticUnanalyzable ?? [];
  const pageMetadataCandidates = report.pageMetadataCandidates ?? [];
  const pageMetadataUnanalyzable = report.pageMetadataUnanalyzable ?? [];

  if (
    report.collectionCandidates.length === 0 &&
    report.unanalyzable.length === 0 &&
    staticContentCandidates.length === 0 &&
    staticUnanalyzable.length === 0 &&
    pageMetadataCandidates.length === 0 &&
    pageMetadataUnanalyzable.length === 0
  ) {
    return "No repetitive content candidates found.";
  }

  const lines: string[] = [];

  if (report.collectionCandidates.length > 0) {
    lines.push("Collection candidates:");
    for (const candidate of report.collectionCandidates) {
      const location = formatLocation(report.appDir, candidate.sourceFile, candidate.declarationFile);
      lines.push(
        `  [${candidate.section}] ${candidate.variableName}  (${location})  — ${candidate.itemCount} items, used on ${formatRoutes(candidate.usedOnRoutes)}`,
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
      const location = formatLocation(report.appDir, item.sourceFile, item.declarationFile);
      lines.push(`  [${item.section}] ${item.variableName}  (${location})  — ${item.reason}  (used on ${formatRoutes(item.usedOnRoutes)})`);
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

  if (pageMetadataCandidates.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Page metadata candidates:");
    for (const candidate of pageMetadataCandidates) {
      const rel = path.relative(report.appDir, candidate.sourceFile);
      const fields = [
        candidate.title !== undefined ? `title: "${candidate.title}"` : null,
        candidate.description !== undefined ? `description: "${candidate.description}"` : null,
        candidate.canonical !== undefined ? `canonical: "${candidate.canonical}"` : null,
      ].filter(Boolean);
      lines.push(`  [${candidate.routePath}] ${rel}  — ${fields.join(", ")}`);
    }
  }

  if (pageMetadataUnanalyzable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Detected but not import-eligible (page metadata):");
    for (const item of pageMetadataUnanalyzable) {
      const rel = path.relative(report.appDir, item.sourceFile);
      lines.push(`  [${item.routePath}] ${rel}  — ${item.reason}`);
    }
  }

  return lines.join("\n");
}

/**
 * The report with every absolute path rewritten project-root-relative (posix
 * separators) — the shape `--json` prints to stdout. Absolute paths would make
 * the output useless as a CI artifact or cross-machine diff. The on-disk cache
 * (saveScanReport) deliberately keeps absolute paths: `cimisy import`'s
 * codemods consume it on the same machine that produced it.
 */
export function toPortableReport(report: ScanReport, projectRoot: string): ScanReport {
  const rel = (absolute: string): string => path.relative(projectRoot, absolute).split(path.sep).join("/");
  return {
    ...report,
    appDir: rel(report.appDir),
    pages: report.pages.map((p) => ({ ...p, pagePath: rel(p.pagePath) })),
    entrypoints: report.entrypoints?.map((e) => ({ ...e, filePath: rel(e.filePath) })),
    collectionCandidates: report.collectionCandidates.map((c) => ({
      ...c,
      sourceFile: rel(c.sourceFile),
      declarationFile: rel(c.declarationFile),
    })),
    unanalyzable: report.unanalyzable.map((u) => ({ ...u, sourceFile: rel(u.sourceFile), declarationFile: rel(u.declarationFile) })),
    staticContentCandidates: report.staticContentCandidates?.map((c) => ({ ...c, sourceFile: rel(c.sourceFile) })),
    staticUnanalyzable: report.staticUnanalyzable?.map((u) => ({ ...u, sourceFile: rel(u.sourceFile) })),
    pageMetadataCandidates: report.pageMetadataCandidates?.map((c) => ({ ...c, sourceFile: rel(c.sourceFile) })),
    pageMetadataUnanalyzable: report.pageMetadataUnanalyzable?.map((u) => ({ ...u, sourceFile: rel(u.sourceFile) })),
  };
}

export interface ScanFindingCounts {
  collectionCandidates: number;
  staticCandidates: number;
  metadataCandidates: number;
  unanalyzable: number;
}

export function countScanFindings(report: ScanReport): ScanFindingCounts {
  return {
    collectionCandidates: report.collectionCandidates.length,
    staticCandidates: report.staticContentCandidates?.length ?? 0,
    metadataCandidates: report.pageMetadataCandidates?.length ?? 0,
    unanalyzable:
      report.unanalyzable.length + (report.staticUnanalyzable?.length ?? 0) + (report.pageMetadataUnanalyzable?.length ?? 0),
  };
}

/**
 * `cimisy scan --ci`'s exit-code contract: 0 = clean, 1 = findings exist.
 * Unanalyzable detections count as findings on purpose — they ARE hardcoded
 * content the scanner saw (just not auto-importable), and a gate that ignored
 * them would report "clean" while content drifts in. Use `scan.exclude` /
 * a narrower mode to silence areas deliberately out of scope. (Exit 2 =
 * the scan itself failed; decided in the CLI, not here.)
 */
export function scanFindingsExitCode(report: ScanReport): 0 | 1 {
  const counts = countScanFindings(report);
  const total = counts.collectionCandidates + counts.staticCandidates + counts.metadataCandidates + counts.unanalyzable;
  return total === 0 ? 0 : 1;
}

export function formatScanSummaryLine(report: ScanReport): string {
  const counts = countScanFindings(report);
  return (
    `cimisy scan (${report.mode ?? "collections"}): ` +
    `${counts.collectionCandidates} collection candidate(s), ${counts.staticCandidates} static, ` +
    `${counts.metadataCandidates} metadata, ${counts.unanalyzable} not import-eligible`
  );
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
