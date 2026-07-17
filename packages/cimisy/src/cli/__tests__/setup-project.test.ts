import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configImportSpecifier, isProjectSetUp, setupProject } from "../setup-project.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve, allowJs: true },
    reportDiagnostics: true,
  });
  expect((diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
}

describe("setupProject", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-setup-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function scaffoldNextApp(appDirSegments: string[], tsconfig?: object): Promise<string> {
    const appDir = path.join(root, ...appDirSegments);
    await mkdir(appDir, { recursive: true });
    if (tsconfig) await writeFile(path.join(root, "tsconfig.json"), JSON.stringify(tsconfig), "utf8");
    return appDir;
  }

  it("scaffolds config, admin page, and API route in a fresh TS project with a root @/* alias", async () => {
    await scaffoldNextApp(["app"], { compilerOptions: { paths: { "@/*": ["./*"] } } });

    const result = await setupProject(root);
    expect(result.actions).toEqual([
      { file: "cimisy.config.ts", status: "created" },
      { file: path.join("app", "(cimisy)", "admin", "[[...segments]]", "page.tsx"), status: "created" },
      { file: path.join("app", "api", "cimisy", "[...route]", "route.ts"), status: "created" },
    ]);

    const page = await readFile(path.join(root, "app", "(cimisy)", "admin", "[[...segments]]", "page.tsx"), "utf8");
    expect(page).toContain(`import cimisyConfig from "@/cimisy.config";`);
    expect(page).toContain("CimisyAdminPage");
    assertNoSyntaxErrors(page);

    const route = await readFile(path.join(root, "app", "api", "cimisy", "[...route]", "route.ts"), "utf8");
    expect(route).toContain(`import cimisyConfig from "@/cimisy.config";`);
    expect(route).toContain("createCimisyHandler");
    assertNoSyntaxErrors(route);

    const config = await readFile(path.join(root, "cimisy.config.ts"), "utf8");
    expect(config).toContain("localSource");
    assertNoSyntaxErrors(config);

    expect(await isProjectSetUp(root)).toBe(true);
  });

  it("falls back to relative config imports when the alias doesn't cover the project root (src/app layout)", async () => {
    await scaffoldNextApp(["src", "app"], { compilerOptions: { paths: { "@/*": ["./src/*"] } } });

    await setupProject(root);

    const page = await readFile(path.join(root, "src", "app", "(cimisy)", "admin", "[[...segments]]", "page.tsx"), "utf8");
    expect(page).toContain(`import cimisyConfig from "../../../../../cimisy.config";`);
    const route = await readFile(path.join(root, "src", "app", "api", "cimisy", "[...route]", "route.ts"), "utf8");
    expect(route).toContain(`import cimisyConfig from "../../../../../cimisy.config";`);
  });

  it("is idempotent: a second run reports every file as existing and overwrites nothing", async () => {
    await scaffoldNextApp(["app"], { compilerOptions: {} });
    await setupProject(root);

    const pagePath = path.join(root, "app", "(cimisy)", "admin", "[[...segments]]", "page.tsx");
    await writeFile(pagePath, "// hand-edited\n", "utf8");

    const second = await setupProject(root);
    expect(second.actions.map((a) => a.status)).toEqual(["exists", "exists", "exists"]);
    expect(await readFile(pagePath, "utf8")).toBe("// hand-edited\n");
  });

  it("respects an existing hand-mounted admin page outside the (cimisy) route group", async () => {
    const appDir = await scaffoldNextApp(["app"], { compilerOptions: {} });
    const handMounted = path.join(appDir, "admin", "[[...segments]]");
    await mkdir(handMounted, { recursive: true });
    await writeFile(path.join(handMounted, "page.tsx"), "export default function P() { return null; }\n", "utf8");

    const result = await setupProject(root);
    expect(result.actions).toContainEqual({ file: path.join("app", "admin", "[[...segments]]", "page.tsx"), status: "exists" });
    expect(result.actions.filter((a) => a.file.includes("(cimisy)"))).toEqual([]);
  });

  it("respects an existing hand-authored cimisy.config.js and scaffolds .js/.jsx files in a plain-JavaScript project", async () => {
    await scaffoldNextApp(["app"]); // no tsconfig.json
    await writeFile(path.join(root, "cimisy.config.js"), "export default {};\n", "utf8");

    const result = await setupProject(root);
    expect(result.actions).toEqual([
      { file: "cimisy.config.js", status: "exists" },
      { file: path.join("app", "(cimisy)", "admin", "[[...segments]]", "page.jsx"), status: "created" },
      { file: path.join("app", "api", "cimisy", "[...route]", "route.js"), status: "created" },
    ]);

    const page = await readFile(path.join(root, "app", "(cimisy)", "admin", "[[...segments]]", "page.jsx"), "utf8");
    // No TS-only syntax in a .jsx file, and no alias without a tsconfig — relative import of the real .js config.
    expect(page).toContain("async function AdminPage({ params })");
    expect(page).toContain(`import cimisyConfig from "../../../../cimisy.config.js";`);
    assertNoSyntaxErrors(page);
  });

  it("throws (creating nothing) when there is no App Router app directory", async () => {
    await expect(setupProject(root)).rejects.toThrow(/app.*directory/i);
    expect(await isProjectSetUp(root)).toBe(false);
  });
});

describe("configImportSpecifier", () => {
  it("uses an alias whose target contains the config file, skipping ones that don't", () => {
    const spec = configImportSpecifier(
      "/proj/app/api/cimisy/[...route]/route.ts",
      "/proj/cimisy.config.ts",
      { "~/*": "./src/*", "@/*": "./*" },
      "/proj",
    );
    expect(spec).toBe("@/cimisy.config");
  });
});
