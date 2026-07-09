#!/usr/bin/env node
import * as clack from "@clack/prompts";
import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { humanizeLabel } from "../codegen/insert-collection-config.js";
import { applyCandidate } from "../scan/apply.js";
import { defaultReportPath, loadScanReport, printScanReport, runScan, saveScanReport } from "../scan/report.js";

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findAppDir(projectRoot: string): Promise<string> {
  const candidates = [path.join(projectRoot, "src", "app"), path.join(projectRoot, "app")];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(
    `Could not find an App Router "app" directory under ${projectRoot} (looked for src/app and app). ` +
      `The Pages Router (pages/) is not supported by "cimisy scan" yet.`,
  );
}

/** Reads tsconfig.json's compilerOptions.paths (e.g. "@/*": ["./src/*"]) via the TS compiler API, which tolerates comments/trailing commas that plain JSON.parse would choke on. */
async function readPathAliases(projectRoot: string): Promise<Record<string, string>> {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) return {};

  const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const paths = config?.compilerOptions?.paths as Record<string, string[]> | undefined;
  if (!paths) return {};

  const aliases: Record<string, string> = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (targets[0]) aliases[pattern] = targets[0];
  }
  return aliases;
}

async function runScanCommand(projectRoot: string): Promise<void> {
  const appDir = await findAppDir(projectRoot);
  const pathAliases = await readPathAliases(projectRoot);
  const report = await runScan({ appDir, projectRoot, pathAliases });

  console.log(printScanReport(report));

  const cachePath = defaultReportPath(projectRoot);
  await saveScanReport(report, cachePath);
  console.log(`\nSaved machine-readable report to ${path.relative(projectRoot, cachePath)}`);
  console.log(`Run "cimisy import" to select candidates to bring under cimisy's management.`);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

function isWorkingTreeClean(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd) === "";
}

function createImportBranch(cwd: string): string {
  const branch = `cimisy/import-${Date.now()}`;
  git(["checkout", "-b", branch], cwd);
  return branch;
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
  if (report.collectionCandidates.length === 0) {
    console.log("No collection candidates in the last scan report. Nothing to import.");
    return;
  }

  if (!isGitRepo(projectRoot)) {
    console.error("cimisy import must run inside a git repository — it creates a dedicated branch before writing anything.");
    process.exitCode = 1;
    return;
  }
  if (!allowDirty && !isWorkingTreeClean(projectRoot)) {
    console.error(
      "Working tree has uncommitted changes. Commit or stash them first, or re-run with --allow-dirty if you understand the risk.",
    );
    process.exitCode = 1;
    return;
  }

  clack.intro("cimisy import");

  const selected = await clack.multiselect({
    message: "Select candidates to bring under cimisy's management:",
    options: report.collectionCandidates.map((c, i) => ({
      value: i,
      label: `${c.variableName} (${c.itemCount} items) — ${path.relative(report.appDir, c.sourceFile)}`,
      hint: c.usedOnRoutes.slice(0, 3).join(", "),
    })),
    required: false,
  });

  if (clack.isCancel(selected) || selected.length === 0) {
    clack.cancel("Nothing selected — no changes made.");
    return;
  }

  const branch = createImportBranch(projectRoot);
  clack.log.info(`Created branch ${branch}`);

  const configFilePath = path.join(projectRoot, "cimisy.config.ts");
  for (const index of selected) {
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
  }

  clack.outro(`Done. Review the changes with "git diff" on branch ${branch}, then commit when you're happy with them.`);
}

function printUsage(): void {
  console.log(
    [
      "Usage: cimisy <command>",
      "",
      "Commands:",
      "  scan     Scan the app for repetitive hardcoded content and report collection candidates",
      "  import   Interactively select scanned candidates and import them into cimisy",
      "           --allow-dirty  skip the clean-git-working-tree check",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const projectRoot = process.cwd();

  switch (command) {
    case "scan":
      await runScanCommand(projectRoot);
      return;
    case "import":
      await runImportCommand(projectRoot, rest);
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
