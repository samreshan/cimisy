import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { detectScanConfig, pathExists as configPathExists, resolveConfigFilePath, type ScanConfigDetection } from "./config-detection.js";
import { DEFAULT_SCAN_MODE, type ScanMode } from "./modes.js";
import { defaultReportPath, runScan, saveScanReport, type ScanReport } from "./report.js";

/**
 * Everything between "a project root" and "a saved scan report" —
 * app-directory discovery, tsconfig path aliases, the config file's static
 * `scan: {...}` defaults, running the scan, and caching the result at
 * .cimisy/scan-report.json. Extracted from cli/index.ts so the dev-only
 * in-admin scan surface (next/route-handler.ts) runs the exact same scan
 * the CLI does, rather than a reimplementation that could drift.
 */

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findAppDir(projectRoot: string): Promise<string> {
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
export async function readPathAliases(projectRoot: string): Promise<Record<string, string>> {
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

/** Reads the optional `scan: {...}` defaults out of cimisy.config.* — statically, without executing the config. Missing config file → no defaults. */
export async function readScanConfig(projectRoot: string): Promise<ScanConfigDetection> {
  const configFilePath = await resolveConfigFilePath(projectRoot);
  if (!(await configPathExists(configFilePath))) return { warnings: [] };
  const configText = await readFile(configFilePath, "utf8");
  return detectScanConfig(configText, configFilePath);
}

export interface RunProjectScanResult {
  report: ScanReport;
  /** Static-config parse warnings (see detectScanConfig) — surfaced to the caller, never fatal. */
  warnings: string[];
  /** Where the machine-readable report was cached (absolute). */
  cachePath: string;
}

/**
 * Runs a scan for a whole project and caches the report. `mode` overrides
 * the config file's `scan.mode` (mirroring the CLI's `--mode` precedence);
 * when omitted, the config default (or "collections") applies.
 */
export async function runProjectScan(projectRoot: string, options: { mode?: ScanMode } = {}): Promise<RunProjectScanResult> {
  const scanConfig = await readScanConfig(projectRoot);
  const mode = options.mode ?? scanConfig.mode ?? DEFAULT_SCAN_MODE;
  const appDir = await findAppDir(projectRoot);
  const pathAliases = await readPathAliases(projectRoot);
  const report = await runScan({ appDir, projectRoot, pathAliases, mode, exclude: scanConfig.exclude });

  const cachePath = defaultReportPath(projectRoot);
  await saveScanReport(report, cachePath);
  return { report, warnings: scanConfig.warnings, cachePath };
}
