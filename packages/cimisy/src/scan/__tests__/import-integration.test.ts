import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStaticCandidate } from "../apply-static-content.js";
import { resolveConfigFilePath } from "../config-detection.js";
import { runScan } from "../report.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve, allowJs: true },
    reportDiagnostics: true,
  });
  expect((diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
}

describe("cimisy import — end-to-end against a realistic pre-existing project", () => {
  let root: string;
  let appDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-integration-"));
    appDir = path.join(root, "app");
    await mkdir(appDir, { recursive: true });
    // Pre-existing hand-authored cimisy.config.js with a jobs collection, matching the bug report's setup.
    await writeFile(
      path.join(root, "cimisy.config.js"),
      [
        `const { collection, config, fields } = require("cimisy/config");`,
        `const { localSource } = require("cimisy/adapters/local");`,
        `module.exports = config({`,
        `  source: localSource({ rootDir: "./content" }),`,
        `  collections: {`,
        `    jobs: collection({ label: "Jobs", path: "jobs/*.mdx", slugField: "slug", schema: { slug: fields.slug({ source: "title" }), title: fields.text({ label: "Title" }) } }),`,
        `  },`,
        `});`,
        ``,
      ].join("\n"),
    );
    await mkdir(path.join(appDir, "careers"), { recursive: true });
    await writeFile(
      path.join(appDir, "careers", "CareersPage.jsx"),
      `
        export function CareersPage() {
          return (
            <div>
              <section id="open-roles"><h1>Open Roles</h1></section>
              <section id="team-culture"><h1>Team Culture</h1></section>
            </div>
          );
        }
      `,
    );
    await writeFile(
      path.join(appDir, "careers", "page.jsx"),
      `
        import { CareersPage } from "./CareersPage";
        export default function Page() { return <CareersPage />; }
      `,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the existing .js config, merges hyphenated-key sections into one page, and emits plain JS", async () => {
    const configFilePath = await resolveConfigFilePath(root);
    expect(configFilePath).toBe(path.join(root, "cimisy.config.js"));

    const report = await runScan({ appDir, projectRoot: root, full: true });
    expect(report.staticContentCandidates).toHaveLength(2);

    for (const candidate of report.staticContentCandidates!) {
      const result = await applyStaticCandidate({ candidate, configFilePath });
      expect(result.error).toBeUndefined();
    }

    const configText = await readFile(configFilePath, "utf8");
    assertNoSyntaxErrors(configText);
    // pre-existing jobs collection is preserved, not clobbered by a fresh scaffold
    expect(configText).toContain("jobs: collection({");
    // one merged careers page, not two
    expect((configText.match(/careers:\s*page\(/g) ?? []).length).toBe(1);
    // hyphenated section keys are quoted
    expect(configText).toContain('"open-roles": section({');
    expect(configText).toContain('"team-culture": section({');

    const rewrittenSource = await readFile(path.join(appDir, "careers", "CareersPage.jsx"), "utf8");
    assertNoSyntaxErrors(rewrittenSource);
    // no TS-only `as {...}` cast leaked into a plain .jsx file
    expect(rewrittenSource).not.toContain(" as {");
    // exactly one, correctly-ordered cimisyReader bootstrap
    expect((rewrittenSource.match(/const cimisyReader = createReader/g) ?? []).length).toBe(1);
    const bootstrapPos = rewrittenSource.indexOf("const cimisyReader = createReader");
    const firstUsePos = rewrittenSource.indexOf("cimisyReader.pages");
    expect(bootstrapPos).toBeLessThan(firstUsePos);
  });
});
