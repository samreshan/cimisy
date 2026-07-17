#!/usr/bin/env node
import * as clack from "@clack/prompts";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { humanizeLabel } from "../codegen/insert-collection-config.js";
import { applyCandidate } from "../scan/apply.js";
import { applyPageMetadataCandidate } from "../scan/apply-page-metadata.js";
import { applyStaticCandidate } from "../scan/apply-static-content.js";
import { resolveConfigFilePath, type ScanConfigDetection } from "../scan/config-detection.js";
import { createImportBranch, DIRTY_TREE_MESSAGE, isGitRepo, isWorkingTreeClean, NOT_A_GIT_REPO_MESSAGE } from "../scan/git.js";
import { DEFAULT_SCAN_MODE, isScanMode, SCAN_MODES, type ScanMode } from "../scan/modes.js";
import { readScanConfig, runProjectScan } from "../scan/run-project-scan.js";
import { isProjectSetUp, setupProject } from "./setup-project.js";
import {
  defaultReportPath,
  formatScanSummaryLine,
  loadScanReport,
  printScanReport,
  scanFindingsExitCode,
  toPortableReport,
  type StaticContentCandidateReport,
} from "../scan/report.js";

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Thrown for CLI misuse (unknown mode, conflicting flags) — exits with code 2, distinct from a scan that ran and found candidates (see runScanCommand). */
export class CliUsageError extends Error {}

/** Parses `--mode=value` or `--mode value` out of args. Returns undefined when absent. */
export function parseModeFlag(args: string[]): ScanMode | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg.startsWith("--mode=")) value = arg.slice("--mode=".length);
    else if (arg === "--mode") value = args[i + 1];
    else continue;
    if (!value || !isScanMode(value)) {
      throw new CliUsageError(`Unknown scan mode "${value ?? ""}". Expected one of: ${SCAN_MODES.join(", ")}.`);
    }
    return value;
  }
  return undefined;
}

/** Precedence: `--mode` > `--full` (shorthand for static-metadata, the everything mode) > cimisy.config's scan.mode > "collections". */
export function resolveMode(args: string[], scanConfig: Pick<ScanConfigDetection, "mode">): ScanMode {
  const modeFlag = parseModeFlag(args);
  const full = args.includes("--full");
  if (modeFlag && full) {
    throw new CliUsageError(`--full is shorthand for --mode=static-metadata — pass one or the other, not both.`);
  }
  if (modeFlag) return modeFlag;
  if (full) return "static-metadata";
  return scanConfig.mode ?? DEFAULT_SCAN_MODE;
}

async function runScanCommand(projectRoot: string, args: string[]): Promise<void> {
  const json = args.includes("--json");
  const ci = args.includes("--ci");

  let report;
  try {
    const scanConfig = await readScanConfig(projectRoot);
    for (const warning of scanConfig.warnings) console.error(warning);
    const mode = resolveMode(args, scanConfig);
    const result = await runProjectScan(projectRoot, { mode });
    report = result.report;
    const cachePath = result.cachePath;

    if (json) {
      // Machine-readable to stdout, everything else to stderr — `cimisy scan --json | jq` must see pure JSON.
      console.log(JSON.stringify(toPortableReport(report, projectRoot), null, 2));
    } else if (!ci) {
      console.log(`Scan mode: ${report.mode}\n`);
      console.log(printScanReport(report));
      console.log(`\nSaved machine-readable report to ${path.relative(projectRoot, cachePath)}`);
      console.log(`Next (step 2 of 3): run "cimisy import" to select candidates to bring under cimisy's management.`);
      if (!(await isProjectSetUp(projectRoot))) {
        console.log(`Then (step 3 of 3): run "cimisy setup" to mount the admin UI and API route.`);
      }
    }
  } catch (err) {
    // Under --ci the scan-failed case must be distinguishable (exit 2) from "findings exist" (exit 1).
    if (err instanceof CliUsageError || ci) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (ci) {
    console.error(formatScanSummaryLine(report));
    process.exitCode = scanFindingsExitCode(report);
  }
}

async function runImportCommand(projectRoot: string, args: string[]): Promise<void> {
  const allowDirty = args.includes("--allow-dirty");

  const cachePath = defaultReportPath(projectRoot);
  if (!(await pathExists(cachePath))) {
    console.error(`No scan report found at ${path.relative(projectRoot, cachePath)}. Run "cimisy scan" first.`);
    process.exitCode = 1;
    return;
  }
  const report = await loadScanReport(cachePath);
  const staticCandidates: StaticContentCandidateReport[] = report.staticContentCandidates ?? [];
  // Only candidates a pre-2.3 report couldn't have stamped with pageKey are importable.
  const metadataCandidates = (report.pageMetadataCandidates ?? []).filter((c) => c.pageKey);
  if (report.collectionCandidates.length === 0 && staticCandidates.length === 0 && metadataCandidates.length === 0) {
    console.log("No candidates in the last scan report. Nothing to import.");
    return;
  }

  if (!isGitRepo(projectRoot)) {
    console.error(NOT_A_GIT_REPO_MESSAGE);
    process.exitCode = 1;
    return;
  }
  if (!allowDirty && !isWorkingTreeClean(projectRoot)) {
    console.error(DIRTY_TREE_MESSAGE);
    process.exitCode = 1;
    return;
  }

  clack.intro("cimisy import");

  // Encoded as a plain string ("collection:3" / "static:1") rather than a tagged
  // object, because @clack/prompts' Option<Value> type is a distributive
  // conditional over Value — passing a union-of-objects Value makes TypeScript
  // check the options array against a distributed union of narrower shapes,
  // which a single combined array can never satisfy. A Primitive Value sidesteps
  // that entirely.
  const collectionOptions = report.collectionCandidates.map((c, i) => ({
    value: `collection:${i}`,
    label: `[collection] ${c.variableName} (${c.itemCount} items) — ${path.relative(report.appDir, c.sourceFile)}`,
    hint: c.usedOnRoutes.slice(0, 3).join(", "),
  }));
  const staticOptions = [...staticCandidates]
    .sort((a, b) => a.proposedKey.localeCompare(b.proposedKey))
    .map((c) => {
      const index = staticCandidates.indexOf(c);
      const scopeLabel = c.scope === "top-level-singleton" ? "singleton" : "section";
      const fieldCount = c.fields.length;
      return {
        value: `static:${index}`,
        label: `[${scopeLabel}] ${c.proposedKey} (${fieldCount} field${fieldCount === 1 ? "" : "s"}) — ${path.relative(report.appDir, c.sourceFile)}`,
        hint: c.usedOnRoutes.slice(0, 3).join(", "),
      };
    });

  const metadataOptions = metadataCandidates.map((c, i) => {
    const parts = [
      c.title !== undefined ? "title" : null,
      c.description !== undefined ? "description" : null,
      c.canonical !== undefined ? "canonical" : null,
    ].filter(Boolean);
    return {
      value: `metadata:${i}`,
      label: `[metadata] ${c.routePath} (${parts.join(", ")}) — ${path.relative(report.appDir, c.sourceFile)}`,
      hint: `pages.${c.pageKey}.seo`,
    };
  });

  const selected = await clack.multiselect<string>({
    message: "Select candidates to bring under cimisy's management:",
    options: [...collectionOptions, ...staticOptions, ...metadataOptions],
    required: false,
  });

  if (clack.isCancel(selected) || selected.length === 0) {
    clack.cancel("Nothing selected — no changes made.");
    return;
  }

  const branch = createImportBranch(projectRoot);
  clack.log.info(`Created branch ${branch}`);

  const configFilePath = await resolveConfigFilePath(projectRoot);
  for (const choice of selected) {
    const [kind, indexText] = choice.split(":");
    const index = Number(indexText);
    if (kind === "collection") {
      const candidate = report.collectionCandidates[index]!;
      const collectionName = candidate.variableName;
      const spin = clack.spinner();
      spin.start(`Importing ${collectionName}...`);
      try {
        const result = await applyCandidate({
          candidate,
          configFilePath,
          collectionName,
          collectionLabel: humanizeLabel(collectionName),
          contentPath: `${collectionName}/*.mdx`,
        });
        const failed = result.items.filter((i) => i.error);
        spin.stop(
          `${collectionName}: ${result.items.length - failed.length}/${result.items.length} items imported` +
            (failed.length > 0 ? `, ${failed.length} failed` : ""),
        );
        for (const failure of failed) {
          clack.log.warn(`  item ${failure.index}: ${failure.error}`);
        }
      } catch (err) {
        spin.stop(`${collectionName}: failed`);
        clack.log.error(err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    if (kind === "metadata") {
      const candidate = metadataCandidates[index]!;
      const key = `pages.${candidate.pageKey}.seo`;
      const spin = clack.spinner();
      spin.start(`Importing ${key}...`);
      try {
        const result = await applyPageMetadataCandidate({ candidate, configFilePath });
        spin.stop(result.error ? `${key}: failed` : `${key}: imported`);
        if (result.error) clack.log.warn(`  ${result.error}`);
      } catch (err) {
        spin.stop(`${key}: failed`);
        clack.log.error(err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    const candidate = staticCandidates[index]!;
    const spin = clack.spinner();
    spin.start(`Importing ${candidate.proposedKey}...`);
    try {
      const result = await applyStaticCandidate({ candidate, configFilePath });
      spin.stop(result.error ? `${candidate.proposedKey}: failed` : `${candidate.proposedKey}: imported`);
      if (result.error) clack.log.warn(`  ${result.error}`);
    } catch (err) {
      spin.stop(`${candidate.proposedKey}: failed`);
      clack.log.error(err instanceof Error ? err.message : String(err));
    }
  }

  const setupHint = (await isProjectSetUp(projectRoot)) ? "" : ` Next (step 3 of 3): run "cimisy setup" to mount the admin UI and API route.`;
  clack.outro(`Done. Review the changes with "git diff" on branch ${branch}, then commit when you're happy with them.${setupHint}`);
}

async function runSetupCommand(projectRoot: string): Promise<void> {
  clack.intro("cimisy setup");
  let result;
  try {
    result = await setupProject(projectRoot);
  } catch (err) {
    clack.log.error(err instanceof Error ? err.message : String(err));
    clack.cancel("Setup did not complete.");
    process.exitCode = 1;
    return;
  }
  for (const action of result.actions) {
    if (action.status === "created") clack.log.success(`created ${action.file}`);
    else clack.log.info(`${action.file} already exists — left untouched`);
  }
  clack.outro(
    `Done. Start your dev server and open /admin. ` +
      `For production, switch the config's source to githubSource — see the cimisy README's "Using the GitHub adapter" section.`,
  );
}

function printUsage(): void {
  console.log(
    [
      "Usage: cimisy <command>",
      "",
      "Getting started (three steps):",
      "  1. npx cimisy scan --full   find hardcoded content across the whole site",
      "  2. npx cimisy import        pick candidates and move them under cimisy's management",
      "  3. npx cimisy setup         scaffold the admin UI page and API route",
      "",
      "Commands:",
      "  scan     Scan the app for hardcoded content and report what could move into cimisy",
      "           --full         shorthand for --mode=static-metadata (scan everything)",
      "           --mode=<mode>  scan depth (default: collections, or cimisy.config's scan.mode):",
      "                            collections            repeating .map()'d arrays only",
      "                            collections-metadata   + page SEO metadata (export const metadata)",
      "                            static                 + static headings/paragraphs/images/links",
      "                            static-metadata        everything above",
      "           --json         print the machine-readable report (project-relative paths) to stdout",
      "           --ci           exit 1 when any candidate or unanalyzable content is found, 2 on scan failure;",
      "                          prints a one-line summary to stderr (combine with --json for the full report)",
      "  import   Interactively select scanned candidates and import them into cimisy",
      "           --allow-dirty  skip the clean-git-working-tree check",
      "  setup    Scaffold cimisy.config (if missing), the admin UI page, and the API route;",
      "           never overwrites existing files — safe to re-run",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const projectRoot = process.cwd();

  switch (command) {
    case "scan":
      await runScanCommand(projectRoot, rest);
      return;
    case "import":
      await runImportCommand(projectRoot, rest);
      return;
    case "setup":
      await runSetupCommand(projectRoot);
      return;
    case undefined:
    case "help":
    case "--help":
      printUsage();
      return;
    default:
      printUsage();
      console.error(`Unknown command: "${command}"`);
      process.exitCode = 1;
  }
}

// Only run when executed as the `cimisy` bin — importing this module (tests
// import the exported flag helpers) must not fire the CLI. realpathSync
// because npm installs the bin as a symlink, so argv[1] is the link path
// while import.meta.url is the resolved file.
function isCliEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
if (isCliEntrypoint()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = err instanceof CliUsageError ? 2 : 1;
  });
}
