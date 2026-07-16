import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStaticCandidate } from "../apply-static-content.js";
import { runScan } from "../report.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages).toEqual([]);
}

describe("applyStaticCandidate", () => {
  let root: string;
  let appDir: string;
  let configFilePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-apply-static-"));
    appDir = path.join(root, "src", "app");
    await mkdir(appDir, { recursive: true });
    configFilePath = path.join(root, "cimisy.config.ts");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a real content file, updates cimisy.config.ts with a page/section, and rewrites the source end to end", async () => {
    await mkdir(path.join(appDir, "about"), { recursive: true });
    await writeFile(
      path.join(appDir, "about", "page.tsx"),
      `
        export default function About() {
          return (
            <section id="hero">
              <h1>About us</h1>
              <p>We build things.</p>
            </section>
          );
        }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root, full: true });
    expect(report.staticContentCandidates).toHaveLength(1);
    const candidate = report.staticContentCandidates![0]!;
    expect(candidate.scope).toBe("page-section");

    const result = await applyStaticCandidate({ candidate, configFilePath });

    expect(result.configFileCreated).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.filePath).toBeDefined();

    const content = await readFile(result.filePath!, "utf8");
    expect(content).toContain("---");
    expect(content).toContain("heading: About us");

    const configText = await readFile(configFilePath, "utf8");
    assertNoSyntaxErrors(configText);
    expect(configText).toContain("pages: {");
    expect(configText).toContain("about: page({");
    expect(configText).toContain("hero: section({");

    const rewrittenSource = await readFile(path.join(appDir, "about", "page.tsx"), "utf8");
    assertNoSyntaxErrors(rewrittenSource);
    expect(rewrittenSource).not.toContain("About us");
    expect(rewrittenSource).toContain('(cimisyReader.pages.about.hero as import("cimisy/next").SingletonReader).get()');
    expect(rewrittenSource).toContain("export default async function About()");
  });

  it("writes a top-level singleton for content shared across routes and updates the config", async () => {
    await mkdir(path.join(root, "src", "components"), { recursive: true });
    await writeFile(
      path.join(root, "src", "components", "Footer.tsx"),
      `export function Footer() { return <footer id="footer"><span>All rights reserved</span></footer>; }`,
    );
    for (const route of ["about", "contact"]) {
      await mkdir(path.join(appDir, route), { recursive: true });
      await writeFile(
        path.join(appDir, route, "page.tsx"),
        `import { Footer } from "@/components/Footer"; export default function P() { return <Footer />; }`,
      );
    }

    const report = await runScan({ appDir, projectRoot: root, pathAliases: { "@/*": "./src/*" }, full: true });
    expect(report.staticContentCandidates).toHaveLength(1);
    const candidate = report.staticContentCandidates![0]!;
    expect(candidate.scope).toBe("top-level-singleton");

    const result = await applyStaticCandidate({ candidate, configFilePath });
    expect(result.error).toBeUndefined();

    const configText = await readFile(configFilePath, "utf8");
    assertNoSyntaxErrors(configText);
    expect(configText).toContain("singletons: {");
    expect(configText).toContain("footer: singleton({");

    const rewrittenSource = await readFile(path.join(root, "src", "components", "Footer.tsx"), "utf8");
    assertNoSyntaxErrors(rewrittenSource);
    expect(rewrittenSource).toContain("cimisyReader.singletons.footer.get()");
  });

  it("refuses to apply against a githubSource config, without touching any files", async () => {
    await writeFile(
      path.join(appDir, "page.tsx"),
      `export default function Home() { return <section id="hero"><h1>Welcome</h1></section>; }`,
    );
    await writeFile(
      configFilePath,
      [
        `import { collection, config, fields } from "cimisy/config";`,
        `import { githubSource } from "cimisy/adapters/github";`,
        `export default config({ source: githubSource({ repo: "acme/site", appId: "1", privateKey: "x", clientId: "x", clientSecret: "x", sessionSecret: "x" }), collections: {} });`,
      ].join("\n"),
    );

    const report = await runScan({ appDir, projectRoot: root, full: true });
    const candidate = report.staticContentCandidates![0]!;

    await expect(applyStaticCandidate({ candidate, configFilePath })).rejects.toThrow(/githubSource/);

    const sourceUnchanged = await readFile(path.join(appDir, "page.tsx"), "utf8");
    expect(sourceUnchanged).toContain("<h1>Welcome</h1>");
  });

  it("names the actual config file in the githubSource refusal, not a hardcoded \"cimisy.config.ts\"", async () => {
    await writeFile(
      path.join(appDir, "page.tsx"),
      `export default function Home() { return <section id="hero"><h1>Welcome</h1></section>; }`,
    );
    const jsConfigFilePath = path.join(root, "cimisy.config.js");
    await writeFile(
      jsConfigFilePath,
      [
        `const { config } = require("cimisy/config");`,
        `const { githubSource } = require("cimisy/adapters/github");`,
        `module.exports = config({ source: githubSource({ repo: "acme/site", appId: "1", privateKey: "x", clientId: "x", clientSecret: "x", sessionSecret: "x" }), collections: {} });`,
      ].join("\n"),
    );

    const report = await runScan({ appDir, projectRoot: root, full: true });
    const candidate = report.staticContentCandidates![0]!;

    await expect(applyStaticCandidate({ candidate, configFilePath: jsConfigFilePath })).rejects.toThrow("cimisy.config.js uses githubSource");
  });

  it("isolates a later failure (e.g. a key collision) from a previously-applied candidate's changes", async () => {
    await mkdir(path.join(root, "src", "components"), { recursive: true });
    await writeFile(
      path.join(root, "src", "components", "Footer.tsx"),
      `export function Footer() { return <footer id="footer"><span>All rights reserved</span></footer>; }`,
    );
    for (const route of ["about", "contact"]) {
      await mkdir(path.join(appDir, route), { recursive: true });
      await writeFile(
        path.join(appDir, route, "page.tsx"),
        `import { Footer } from "@/components/Footer"; export default function P() { return <Footer />; }`,
      );
    }
    const report = await runScan({ appDir, projectRoot: root, pathAliases: { "@/*": "./src/*" }, full: true });
    const footerCandidate = report.staticContentCandidates!.find((c) => c.proposedKey === "footer")!;

    const first = await applyStaticCandidate({ candidate: footerCandidate, configFilePath });
    expect(first.error).toBeUndefined();
    const configAfterFirst = await readFile(configFilePath, "utf8");
    expect(configAfterFirst).toContain("footer: singleton({");

    // A second candidate whose proposedKey collides with the singleton just created.
    const collidingCandidate = { ...footerCandidate, sourceFile: path.join(root, "src", "components", "Footer.tsx") };
    await expect(applyStaticCandidate({ candidate: collidingCandidate, configFilePath })).rejects.toThrow(/already has a singleton named "footer"/);

    // The first candidate's config entry and written file are untouched by the second attempt's failure.
    const configAfterSecond = await readFile(configFilePath, "utf8");
    expect(configAfterSecond).toContain("footer: singleton({");
    expect((configAfterSecond.match(/footer: singleton\(/g) ?? []).length).toBe(1);
  });

  describe("multiple candidates sharing one source file (cimisy import selecting several at once)", () => {
    it("applies all of them without offset failures, merging into a single page — not one per candidate", async () => {
      await mkdir(path.join(appDir, "careers"), { recursive: true });
      await writeFile(
        path.join(appDir, "careers", "page.tsx"),
        `
          export default function Careers() {
            return (
              <div>
                <section id="block"><h1>Block</h1></section>
                <section id="careers-page"><h1>Careers Page</h1></section>
                <section id="job-item"><h1>Job Item</h1></section>
              </div>
            );
          }
        `,
      );

      const report = await runScan({ appDir, projectRoot: root, full: true });
      expect(report.staticContentCandidates).toHaveLength(3);

      for (const candidate of report.staticContentCandidates!) {
        const result = await applyStaticCandidate({ candidate, configFilePath });
        expect(result.error).toBeUndefined();
      }

      const configText = await readFile(configFilePath, "utf8");
      assertNoSyntaxErrors(configText);
      // one merged page, not three separate "careers: page(" blocks (regression test for the duplicate-page bug)
      expect((configText.match(/careers:\s*page\(/g) ?? []).length).toBe(1);
      // kebab-case-derived section keys are quoted, not bare identifiers
      expect(configText).toContain('"careers-page": section({');
      expect(configText).toContain('"job-item": section({');

      const rewrittenSource = await readFile(path.join(appDir, "careers", "page.tsx"), "utf8");
      assertNoSyntaxErrors(rewrittenSource);
      // exactly one `cimisyReader` bootstrap line, not one per candidate (regression test for the duplicate-const bug)
      expect((rewrittenSource.match(/const cimisyReader = createReader/g) ?? []).length).toBe(1);
      // and it must come before any use of it — inserting a later candidate's fetch ABOVE an earlier
      // candidate's bootstrap is a TDZ ReferenceError at runtime, invisible to a syntax-only check
      const bootstrapPos = rewrittenSource.indexOf("const cimisyReader = createReader");
      const firstUsePos = rewrittenSource.indexOf("cimisyReader.pages");
      expect(bootstrapPos).toBeGreaterThan(-1);
      expect(bootstrapPos).toBeLessThan(firstUsePos);
      expect(rewrittenSource).toContain("blockContent");
      expect(rewrittenSource).toContain("careersPageContent");
      expect(rewrittenSource).toContain("jobItemContent");
    });
  });
});
