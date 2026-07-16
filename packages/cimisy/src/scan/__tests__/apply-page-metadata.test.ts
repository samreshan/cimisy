import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPageMetadataCandidate } from "../apply-page-metadata.js";
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

describe("applyPageMetadataCandidate", () => {
  let root: string;
  let appDir: string;
  let configFilePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-apply-metadata-"));
    appDir = path.join(root, "src", "app");
    await mkdir(appDir, { recursive: true });
    configFilePath = path.join(root, "cimisy.config.ts");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("inserts a pages.<key>.seo section, writes the YAML, and rewrites the page to generateMetadata()", async () => {
    await mkdir(path.join(appDir, "about"), { recursive: true });
    await writeFile(
      path.join(appDir, "about", "page.tsx"),
      `export const metadata = {
  title: "About",
  description: "Who we are",
  openGraph: { url: "https://example.com/about" },
};

export default function About() {
  return <main>about</main>;
}
`,
    );

    const report = await runScan({ appDir, projectRoot: root, mode: "collections-metadata" });
    expect(report.pageMetadataCandidates).toHaveLength(1);
    const candidate = report.pageMetadataCandidates![0]!;
    expect(candidate.pageKey).toBe("about");

    const result = await applyPageMetadataCandidate({ candidate, configFilePath });
    expect(result.configFileCreated).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.key).toBe("about.seo");

    const yaml = await readFile(result.filePath!, "utf8");
    expect(yaml).toContain("title: About");
    expect(yaml).toContain("description: Who we are");
    expect(yaml).toContain("canonical: https://example.com/about");

    const configText = await readFile(configFilePath, "utf8");
    assertNoSyntaxErrors(configText);
    expect(configText).toContain("about: page({");
    expect(configText).toContain("seo: section({");
    expect(configText).toContain("seo: fields.seo()");

    const rewritten = await readFile(path.join(appDir, "about", "page.tsx"), "utf8");
    assertNoSyntaxErrors(rewritten);
    expect(rewritten).not.toContain("export const metadata");
    expect(rewritten).toContain("export async function generateMetadata()");
    expect(rewritten).toContain('(cimisyReader.pages.about.seo as import("cimisy/next").SingletonReader).get()');
  });

  it("surfaces the seo zod schema's refusal of an http:// canonical instead of writing it", async () => {
    await mkdir(path.join(appDir, "about"), { recursive: true });
    await writeFile(
      path.join(appDir, "about", "page.tsx"),
      `export const metadata = { title: "About", openGraph: { url: "http://insecure.example.com/about" } };
export default function About() { return <main>about</main>; }
`,
    );

    const report = await runScan({ appDir, projectRoot: root, mode: "collections-metadata" });
    const candidate = report.pageMetadataCandidates![0]!;
    const result = await applyPageMetadataCandidate({ candidate, configFilePath });
    expect(result.error).toBeDefined();
    expect(result.filePath).toBeUndefined();
  });

  it("coexists with a static section applied to the same page file in the same run (offset-shift regression)", async () => {
    await mkdir(path.join(appDir, "about"), { recursive: true });
    await writeFile(
      path.join(appDir, "about", "page.tsx"),
      `export const metadata = { title: "About" };

export default function About() {
  return (
    <section id="hero">
      <h1>About us</h1>
    </section>
  );
}
`,
    );

    const report = await runScan({ appDir, projectRoot: root, mode: "static-metadata" });
    const staticCandidate = report.staticContentCandidates![0]!;
    const metadataCandidate = report.pageMetadataCandidates![0]!;
    // Both target pages.about — the shared pageKeyForRoute map must agree.
    expect(staticCandidate.pageKey).toBe("about");
    expect(metadataCandidate.pageKey).toBe("about");

    // Static first (shifts every offset in the page file), then metadata.
    const staticResult = await applyStaticCandidate({ candidate: staticCandidate, configFilePath });
    expect(staticResult.error).toBeUndefined();
    const metadataResult = await applyPageMetadataCandidate({ candidate: metadataCandidate, configFilePath });
    expect(metadataResult.error).toBeUndefined();

    const rewritten = await readFile(path.join(appDir, "about", "page.tsx"), "utf8");
    assertNoSyntaxErrors(rewritten);
    expect(rewritten).toContain("export async function generateMetadata()");
    expect(rewritten).toContain("cimisyReader.pages.about.hero as");
    expect(rewritten).toContain('(cimisyReader.pages.about.seo as import("cimisy/next").SingletonReader).get()');

    const configText = await readFile(configFilePath, "utf8");
    assertNoSyntaxErrors(configText);
    // One page entry containing both sections, not two competing "about" pages.
    expect(configText.match(/about: page\(\{/g)).toHaveLength(1);
    expect(configText).toContain("hero: section({");
    expect(configText).toContain("seo: section({");
  });
});
