import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCandidate } from "../apply.js";
import { runScan } from "../report.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages).toEqual([]);
}

describe("applyCandidate", () => {
  let root: string;
  let appDir: string;
  let configFilePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-apply-"));
    appDir = path.join(root, "src", "app");
    await mkdir(path.join(appDir, "news"), { recursive: true });
    configFilePath = path.join(root, "cimisy.config.ts");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes real .mdx files, generates cimisy.config.ts, and rewrites the source file end to end", async () => {
    await writeFile(
      path.join(appDir, "news", "page.tsx"),
      `
        const articles = [
          { title: "Sunflower Institute Featured in TechPana", date: "April 2026", category: "Press" },
          { title: "Nepal Needs a Constructive Nationwide System for Autism", date: "March 2026", category: "Advocacy" },
        ];

        export default function NewsPage() {
          return <div>{articles.map((a, i) => <Card key={i} title={a.title} date={a.date} category={a.category} />)}</div>;
        }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.collectionCandidates).toHaveLength(1);
    const candidate = report.collectionCandidates[0]!;

    const result = await applyCandidate({
      candidate,
      configFilePath,
      collectionName: "news",
      collectionLabel: "News",
      contentPath: "news/*.mdx",
    });

    expect(result.configFileCreated).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => !i.error)).toBe(true);

    // real .mdx files exist with clean frontmatter
    const firstFile = result.items[0]!.filePath!;
    expect(firstFile).toContain(path.join(root, "content", "news"));
    const mdxContent = await readFile(firstFile, "utf8");
    expect(mdxContent).toMatch(/^---\n/);
    expect(mdxContent).toContain("title: Sunflower Institute Featured in TechPana");
    expect(mdxContent).toContain("category: Press");

    // config file was created with the new collection
    const configText = await readFile(configFilePath, "utf8");
    expect(configText).toContain("news: collection({");
    expect(configText).toContain('path: "news/*.mdx"');
    assertNoSyntaxErrors(configText);

    // source file rewritten: array gone, fetch present, JSX untouched, still compiles
    const rewrittenSource = await readFile(path.join(appDir, "news", "page.tsx"), "utf8");
    assertNoSyntaxErrors(rewrittenSource);
    expect(rewrittenSource).not.toContain("TechPana");
    expect(rewrittenSource).toContain("cimisyReader.collections.news.all()");
    expect(rewrittenSource).toContain("articles.map((a, i) => <Card key={i}");
    expect(rewrittenSource).toContain("export default async function NewsPage()");
  });

  it("inserts a second collection into an existing cimisy.config.ts without disturbing the first", async () => {
    await writeFile(
      path.join(appDir, "news", "page.tsx"),
      `
        const articles = [{ title: "A" }];
        export default function NewsPage() {
          return <div>{articles.map(a => <p key={a.title}>{a.title}</p>)}</div>;
        }
      `,
    );
    await mkdir(path.join(appDir, "partners"), { recursive: true });
    await writeFile(
      path.join(appDir, "partners", "page.tsx"),
      `
        const partners = [{ name: "Allora" }, { name: "Codeavatar" }];
        export default function PartnersPage() {
          return <div>{partners.map(p => <p key={p.name}>{p.name}</p>)}</div>;
        }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.collectionCandidates).toHaveLength(2);
    const newsCandidate = report.collectionCandidates.find((c) => c.variableName === "articles")!;
    const partnersCandidate = report.collectionCandidates.find((c) => c.variableName === "partners")!;

    await applyCandidate({
      candidate: newsCandidate,
      configFilePath,
      collectionName: "news",
      collectionLabel: "News",
      contentPath: "news/*.mdx",
    });
    await applyCandidate({
      candidate: partnersCandidate,
      configFilePath,
      collectionName: "partners",
      collectionLabel: "Partners",
      contentPath: "partners/*.mdx",
    });

    const configText = await readFile(configFilePath, "utf8");
    assertNoSyntaxErrors(configText);
    expect(configText).toContain("news: collection({");
    expect(configText).toContain("partners: collection({");
  });

  it("refuses to apply against a githubSource config, without touching any files", async () => {
    await writeFile(
      path.join(appDir, "news", "page.tsx"),
      `
        const articles = [{ title: "A" }];
        export default function NewsPage() {
          return <div>{articles.map(a => <p key={a.title}>{a.title}</p>)}</div>;
        }
      `,
    );
    await writeFile(
      configFilePath,
      [
        `import { collection, config, fields } from "cimisy/config";`,
        `import { githubSource } from "cimisy/adapters/github";`,
        `export default config({ source: githubSource({ repo: "acme/site", appId: "1", privateKey: "x", clientId: "x", clientSecret: "x", sessionSecret: "x" }), collections: {} });`,
      ].join("\n"),
    );

    const report = await runScan({ appDir, projectRoot: root });
    const candidate = report.collectionCandidates[0]!;

    await expect(
      applyCandidate({ candidate, configFilePath, collectionName: "news", collectionLabel: "News", contentPath: "news/*.mdx" }),
    ).rejects.toThrow(/githubSource/);

    const sourceUnchanged = await readFile(path.join(appDir, "news", "page.tsx"), "utf8");
    expect(sourceUnchanged).toContain('const articles = [{ title: "A" }];');
  });

  it("rewrites both files when the array lives in a separate data module (leadership.js shape)", async () => {
    await mkdir(path.join(appDir, "data"), { recursive: true });
    const dataFile = path.join(appDir, "data", "leadership.js");
    await writeFile(
      dataFile,
      `export const leaders = [
        { name: "A", title: "CEO" },
        { name: "B", title: "COO" },
      ];`,
    );
    const componentFile = path.join(appDir, "components", "leadership", "LeadershipGrid.jsx");
    await mkdir(path.dirname(componentFile), { recursive: true });
    await writeFile(
      componentFile,
      `
        import { leaders } from "../../data/leadership";
        export function LeadershipGrid() {
          return <div>{leaders.map((member) => <Card key={member.name} name={member.name} title={member.title} />)}</div>;
        }
      `,
    );
    await mkdir(path.join(appDir, "leadership"), { recursive: true });
    await writeFile(
      path.join(appDir, "leadership", "page.js"),
      `
        import { LeadershipGrid } from "../components/leadership/LeadershipGrid";
        export default function Page() { return <LeadershipGrid />; }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.collectionCandidates).toHaveLength(1);
    const candidate = report.collectionCandidates[0]!;

    const result = await applyCandidate({
      candidate,
      configFilePath,
      collectionName: "leadership",
      collectionLabel: "Leadership",
      contentPath: "leadership/*.mdx",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => !i.error)).toBe(true);
    expect(result.rewrittenSourceFile).toBe(componentFile);
    expect(result.rewrittenDeclarationFile).toBe(dataFile);

    // data module: the array declaration is gone
    const rewrittenData = await readFile(dataFile, "utf8");
    assertNoSyntaxErrors(rewrittenData);
    expect(rewrittenData).not.toContain("leaders");
    expect(rewrittenData).not.toContain("CEO");

    // component file: stale import gone, fetch inserted, JSX untouched, still compiles
    const rewrittenComponent = await readFile(componentFile, "utf8");
    assertNoSyntaxErrors(rewrittenComponent);
    expect(rewrittenComponent).not.toContain("../../data/leadership");
    expect(rewrittenComponent).toContain("cimisyReader.collections.leadership.all()");
    expect(rewrittenComponent).toContain(
      "return <div>{leaders.map((member) => <Card key={member.name} name={member.name} title={member.title} />)}</div>;",
    );
    expect(rewrittenComponent).toContain("export async function LeadershipGrid()");
  });

  it("isolates a per-item write failure instead of aborting the whole import", async () => {
    await writeFile(
      path.join(appDir, "news", "page.tsx"),
      `
        const articles = [
          { title: "Valid Title" },
          { title: "!!!" },
        ];
        export default function NewsPage() {
          return <div>{articles.map((a, i) => <p key={i}>{a.title}</p>)}</div>;
        }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    const candidate = report.collectionCandidates[0]!;

    const result = await applyCandidate({
      candidate,
      configFilePath,
      collectionName: "news",
      collectionLabel: "News",
      contentPath: "news/*.mdx",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.error).toBeUndefined();
    expect(result.items[0]!.slug).toBe("valid-title");
    expect(result.items[1]!.error).toBeDefined();
    // the source file is still rewritten even though one item failed to write
    const rewrittenSource = await readFile(path.join(appDir, "news", "page.tsx"), "utf8");
    expect(rewrittenSource).toContain("cimisyReader.collections.news.all()");
  });
});
