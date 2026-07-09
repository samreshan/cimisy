import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultReportPath, loadScanReport, printScanReport, runScan, saveScanReport } from "../report.js";

describe("runScan", () => {
  let root: string;
  let appDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-report-"));
    appDir = path.join(root, "src", "app");
    await mkdir(appDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a repeating-content candidate declared inline in the page file, labeled 'page'", async () => {
    await mkdir(path.join(appDir, "news"), { recursive: true });
    await writeFile(
      path.join(appDir, "news", "page.tsx"),
      `
        const articles = [
          { title: "A", date: "April 2026", category: "Press" },
          { title: "B", date: "March 2026", category: "Advocacy" },
        ];
        export default function NewsPage() {
          return <div>{articles.map((a, i) => <Card key={i} title={a.title} />)}</div>;
        }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.pages.map((p) => p.routePath)).toEqual(["/news"]);
    expect(report.collectionCandidates).toHaveLength(1);
    const candidate = report.collectionCandidates[0]!;
    expect(candidate.section).toBe("page");
    expect(candidate.variableName).toBe("articles");
    expect(candidate.usedOnRoutes).toEqual(["/news"]);
    expect(candidate.proposal.fields.map((f) => f.name)).toEqual(["title", "date", "category"]);
  });

  it("follows a relative-import component and finds the array declared inside it (SIA's EcosystemGrid shape)", async () => {
    await mkdir(path.join(root, "src", "components"), { recursive: true });
    await writeFile(
      path.join(root, "src", "components", "EcosystemGrid.tsx"),
      `
        const pillars = [
          { name: "Clinical Services", blurb: "Evidence-based therapies" },
          { name: "Sunflower Petals", blurb: "Sensory tools" },
        ];
        export function EcosystemGrid() {
          return <div>{pillars.map(p => <Card key={p.name} title={p.name} />)}</div>;
        }
      `,
    );
    await writeFile(
      path.join(appDir, "page.tsx"),
      `
        import { EcosystemGrid } from "@/components/EcosystemGrid";
        export default function Home() { return <EcosystemGrid />; }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root, pathAliases: { "@/*": "./src/*" } });
    expect(report.collectionCandidates).toHaveLength(1);
    const candidate = report.collectionCandidates[0]!;
    expect(candidate.section).toBe("EcosystemGrid");
    expect(candidate.variableName).toBe("pillars");
  });

  it("deduplicates a shared component's array across every page that renders it (SIA's Navbar scenario)", async () => {
    await mkdir(path.join(root, "src", "components"), { recursive: true });
    await writeFile(
      path.join(root, "src", "components", "Navbar.tsx"),
      `
        const navLinks = [{ label: "Home", href: "/" }, { label: "About", href: "/about" }];
        export function Navbar() { return <nav>{navLinks.map(l => <a key={l.href}>{l.label}</a>)}</nav>; }
      `,
    );
    for (const route of ["about", "contact", "services"]) {
      await mkdir(path.join(appDir, route), { recursive: true });
      await writeFile(
        path.join(appDir, route, "page.tsx"),
        `import { Navbar } from "@/components/Navbar"; export default function P() { return <Navbar />; }`,
      );
    }

    const report = await runScan({ appDir, projectRoot: root, pathAliases: { "@/*": "./src/*" } });
    expect(report.collectionCandidates).toHaveLength(1);
    const candidate = report.collectionCandidates[0]!;
    expect(candidate.variableName).toBe("navLinks");
    expect(candidate.usedOnRoutes.sort()).toEqual(["/about", "/contact", "/services"]);
  });

  it("derives route paths, dropping route-group segments", async () => {
    await mkdir(path.join(appDir, "(marketing)", "about"), { recursive: true });
    await writeFile(path.join(appDir, "(marketing)", "about", "page.tsx"), "export default function About() { return null; }");

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.pages.map((p) => p.routePath)).toEqual(["/about"]);
  });

  it("reports unanalyzable candidates without offering them as collection candidates", async () => {
    await writeFile(
      path.join(appDir, "page.tsx"),
      `
        const items = [{ title: "A", handler: doSomething() }];
        export default function Home() { return <div>{items.map(i => <p key={i.title} />)}</div>; }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.collectionCandidates).toEqual([]);
    expect(report.unanalyzable).toHaveLength(1);
    expect(report.unanalyzable[0]!.section).toBe("page");
    expect(report.unanalyzable[0]!.usedOnRoutes).toEqual(["/"]);
  });
});

describe("printScanReport", () => {
  it("prints a readable report including field kinds and route usage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cimisy-print-"));
    const appDir = path.join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "page.tsx"),
      `
        const articles = [{ title: "A", date: "April 2026" }, { title: "B", date: "March 2026" }];
        export default function Home() { return <div>{articles.map(a => <p key={a.title} />)}</div>; }
      `,
    );
    const report = await runScan({ appDir, projectRoot: root });
    const text = printScanReport(report);
    expect(text).toContain("articles");
    expect(text).toContain("2 items");
    expect(text).toContain("date: text");
    expect(text).toContain("looks like a date");
    expect(text).toContain("used on /");
    await rm(root, { recursive: true, force: true });
  });

  it("prints a friendly message when nothing was found", () => {
    const text = printScanReport({
      generatedAt: new Date().toISOString(),
      appDir: "/x",
      pages: [],
      collectionCandidates: [],
      unanalyzable: [],
    });
    expect(text).toMatch(/No repetitive content candidates/);
  });
});

describe("saveScanReport / loadScanReport", () => {
  it("round-trips a report through disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cimisy-cache-"));
    const report = {
      generatedAt: new Date().toISOString(),
      appDir: "/x",
      pages: [],
      collectionCandidates: [],
      unanalyzable: [],
    };
    const cachePath = defaultReportPath(root);
    await saveScanReport(report, cachePath);
    const loaded = await loadScanReport(cachePath);
    expect(loaded).toEqual(report);
    await rm(root, { recursive: true, force: true });
  });
});
