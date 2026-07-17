import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { scaffoldConfigFile } from "../codegen/insert-collection-config.js";
import { toImportSpecifier } from "../codegen/source-edit-utils.js";
import { resolveConfigFilePath } from "../scan/config-detection.js";
import { findAppDir, readPathAliases } from "../scan/run-project-scan.js";

/**
 * "cimisy setup" — step 3 of the scan → import → setup flow. Scaffolds the
 * pieces the quickstart used to ask people to hand-write: cimisy.config.*
 * (when "cimisy import" hasn't already created one), the admin UI page at
 * (cimisy)/admin/[[...segments]], and the API route at api/cimisy/[...route].
 * Never overwrites: every file that already exists (under any recognized
 * extension) is reported as "exists" and left alone, so re-running setup is
 * always safe.
 */

export interface SetupAction {
  /** Project-root-relative path of the file. */
  file: string;
  status: "created" | "exists";
}

export interface SetupResult {
  actions: SetupAction[];
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Any file whose name (minus extension) matches, under any App Router extension — an existing hand-written admin page.jsx must count as "already set up", not get a page.tsx scaffolded next to it. */
async function findExistingRouteFile(dir: string, baseName: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
    if (entries.includes(`${baseName}${ext}`)) return path.join(dir, `${baseName}${ext}`);
  }
  return undefined;
}

/**
 * Import specifier for cimisy.config as seen from `fromFile`. Prefers a
 * tsconfig path alias (e.g. "@/*": ["./*"] → "@/cimisy.config") because
 * that's what the README teaches and what survives the file being moved;
 * falls back to a plain relative specifier when no alias covers the config
 * file (e.g. "@/*" points into src/ but the config sits at the root).
 */
export function configImportSpecifier(
  fromFile: string,
  configFilePath: string,
  pathAliases: Record<string, string>,
  projectRoot: string,
): string {
  for (const [pattern, target] of Object.entries(pathAliases)) {
    if (!pattern.endsWith("/*") || !target.endsWith("/*")) continue;
    const targetDir = path.resolve(projectRoot, target.slice(0, -2));
    const rel = path.relative(targetDir, configFilePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const withoutExt = rel.replace(/\.tsx?$/, "").split(path.sep).join("/");
    return `${pattern.slice(0, -2)}/${withoutExt}`;
  }
  return toImportSpecifier(fromFile, configFilePath);
}

function adminPageSource(configSpecifier: string, typescript: boolean): string {
  const props = typescript ? "{ params }: { params: Promise<{ segments?: string[] }> }" : "{ params }";
  return [
    `import { CimisyAdminPage } from "cimisy/next";`,
    `import cimisyConfig from ${JSON.stringify(configSpecifier)};`,
    ``,
    `export default async function AdminPage(${props}) {`,
    `  const { segments } = await params;`,
    `  return (`,
    `    <CimisyAdminPage cimisyConfig={cimisyConfig} segments={segments ?? []} basePath="/admin" apiBasePath="/api/cimisy" />`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

function apiRouteSource(configSpecifier: string): string {
  return [
    `import { createCimisyHandler } from "cimisy/next";`,
    `import cimisyConfig from ${JSON.stringify(configSpecifier)};`,
    ``,
    `export const { GET, POST, PUT, DELETE } = createCimisyHandler(cimisyConfig);`,
    ``,
  ].join("\n");
}

/** True once both routes exist — lets scan/import tailor their "next step" hint instead of telling an already-set-up project to run setup again. */
export async function isProjectSetUp(projectRoot: string): Promise<boolean> {
  let appDir: string;
  try {
    appDir = await findAppDir(projectRoot);
  } catch {
    return false;
  }
  const page =
    (await findExistingRouteFile(path.join(appDir, "(cimisy)", "admin", "[[...segments]]"), "page")) ??
    (await findExistingRouteFile(path.join(appDir, "admin", "[[...segments]]"), "page"));
  const route = await findExistingRouteFile(path.join(appDir, "api", "cimisy", "[...route]"), "route");
  return Boolean(page && route);
}

export async function setupProject(projectRoot: string): Promise<SetupResult> {
  const appDir = await findAppDir(projectRoot);
  const typescript = await pathExists(path.join(projectRoot, "tsconfig.json"));
  const actions: SetupAction[] = [];
  const rel = (p: string) => path.relative(projectRoot, p);

  // resolveConfigFilePath falls back to cimisy.config.ts when nothing exists
  // yet; a plain-JavaScript project (no tsconfig.json) gets a .js scaffold
  // instead so its toolchain can actually load the file.
  let configFilePath = await resolveConfigFilePath(projectRoot);
  if (await pathExists(configFilePath)) {
    actions.push({ file: rel(configFilePath), status: "exists" });
  } else {
    if (!typescript) configFilePath = path.join(projectRoot, "cimisy.config.js");
    await writeFile(configFilePath, scaffoldConfigFile(), "utf8");
    actions.push({ file: rel(configFilePath), status: "created" });
  }

  const pathAliases = await readPathAliases(projectRoot);
  const ext = typescript ? "ts" : "js";

  // The (cimisy) route group keeps /admin out of any layout-driven nav
  // without changing the URL. An admin page the project already has —
  // grouped or not, any extension — wins over scaffolding a duplicate route,
  // which Next would reject as two pages resolving to the same path.
  const pageDir = path.join(appDir, "(cimisy)", "admin", "[[...segments]]");
  const existingPage =
    (await findExistingRouteFile(pageDir, "page")) ??
    (await findExistingRouteFile(path.join(appDir, "admin", "[[...segments]]"), "page"));
  if (existingPage) {
    actions.push({ file: rel(existingPage), status: "exists" });
  } else {
    const pagePath = path.join(pageDir, `page.${ext}x`);
    await mkdir(pageDir, { recursive: true });
    await writeFile(pagePath, adminPageSource(configImportSpecifier(pagePath, configFilePath, pathAliases, projectRoot), typescript), "utf8");
    actions.push({ file: rel(pagePath), status: "created" });
  }

  const routeDir = path.join(appDir, "api", "cimisy", "[...route]");
  const existingRoute = await findExistingRouteFile(routeDir, "route");
  if (existingRoute) {
    actions.push({ file: rel(existingRoute), status: "exists" });
  } else {
    const routePath = path.join(routeDir, `route.${ext}`);
    await mkdir(routeDir, { recursive: true });
    await writeFile(routePath, apiRouteSource(configImportSpecifier(routePath, configFilePath, pathAliases, projectRoot)), "utf8");
    actions.push({ file: rel(routePath), status: "created" });
  }

  return { actions };
}
