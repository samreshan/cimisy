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

  it("follows an array imported from its own data module, one hop past the rendering component (leadership.js shape)", async () => {
    await mkdir(path.join(appDir, "data"), { recursive: true });
    await writeFile(
      path.join(appDir, "data", "leadership.js"),
      `export const leaders = [
        { name: "A", title: "CEO" },
        { name: "B", title: "COO" },
      ];`,
    );
    await mkdir(path.join(appDir, "components", "leadership"), { recursive: true });
    await writeFile(
      path.join(appDir, "components", "leadership", "LeadershipGrid.jsx"),
      `
        import { leaders } from "../../data/leadership";
        export function LeadershipGrid() {
          return <div>{leaders.map((member) => <Card key={member.name} name={member.name} />)}</div>;
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
    expect(candidate.variableName).toBe("leaders");
    expect(candidate.section).toBe("LeadershipGrid");
    expect(candidate.sourceFile).toBe(path.join(appDir, "components", "leadership", "LeadershipGrid.jsx"));
    expect(candidate.declarationFile).toBe(path.join(appDir, "data", "leadership.js"));
    expect(candidate.items).toEqual([
      { name: "A", title: "CEO" },
      { name: "B", title: "COO" },
    ]);
  });

  it("resolves JSX components more than one hop deep (thin page.jsx -> XxxPage.jsx -> section component, this repo's own convention)", async () => {
    await mkdir(path.join(appDir, "data"), { recursive: true });
    await writeFile(
      path.join(appDir, "data", "leadership.js"),
      `export const leaders = [{ name: "A", title: "CEO" }];`,
    );
    await mkdir(path.join(appDir, "components", "leadership"), { recursive: true });
    await writeFile(
      path.join(appDir, "components", "leadership", "LeadershipGrid.jsx"),
      `
        import { leaders } from "../../data/leadership";
        export function LeadershipGrid() {
          return <div>{leaders.map((member) => <Card key={member.name} name={member.name} />)}</div>;
        }
      `,
    );
    await writeFile(
      path.join(appDir, "components", "leadership", "LeadershipPage.jsx"),
      `
        "use client";
        import { LeadershipGrid } from "./LeadershipGrid";
        export function LeadershipPage() {
          return <main><h1>Leadership</h1><LeadershipGrid /></main>;
        }
      `,
    );
    await mkdir(path.join(appDir, "leadership"), { recursive: true });
    await writeFile(
      path.join(appDir, "leadership", "page.jsx"),
      `
        import { LeadershipPage } from "../components/leadership/LeadershipPage";
        export default function Page() { return <LeadershipPage />; }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.collectionCandidates).toHaveLength(1);
    const candidate = report.collectionCandidates[0]!;
    expect(candidate.variableName).toBe("leaders");
    // attributed to the deepest component that actually renders it, not the page's direct child
    expect(candidate.section).toBe("LeadershipGrid");
    expect(candidate.sourceFile).toBe(path.join(appDir, "components", "leadership", "LeadershipGrid.jsx"));
    expect(candidate.declarationFile).toBe(path.join(appDir, "data", "leadership.js"));
  });

  it("doesn't loop forever on an import cycle (A renders B renders A)", async () => {
    await mkdir(path.join(appDir, "components"), { recursive: true });
    await writeFile(
      path.join(appDir, "components", "A.jsx"),
      `
        import { B } from "./B";
        export function A({ stop }) { return <div>{!stop && <B />}</div>; }
      `,
    );
    await writeFile(
      path.join(appDir, "components", "B.jsx"),
      `
        import { A } from "./A";
        const items = [{ title: "x" }];
        export function B() { return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}<A stop /></div>; }
      `,
    );
    await writeFile(
      path.join(appDir, "page.jsx"),
      `
        import { A } from "./components/A";
        export default function Page() { return <A />; }
      `,
    );

    const report = await runScan({ appDir, projectRoot: root });
    expect(report.collectionCandidates).toHaveLength(1);
    expect(report.collectionCandidates[0]!.variableName).toBe("items");
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

describe("runScan — static content (--full)", () => {
  let root: string;
  let appDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-report-full-"));
    appDir = path.join(root, "src", "app");
    await mkdir(appDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not analyze static content by default (full: false)", async () => {
    await writeFile(
      path.join(appDir, "page.tsx"),
      `export default function Home() { return <section id="hero"><h1>Welcome</h1></section>; }`,
    );
    const report = await runScan({ appDir, projectRoot: root });
    expect(report.staticContentCandidates).toEqual([]);
    expect(report.staticUnanalyzable).toEqual([]);
  });

  it("proposes a page-scoped section for static content declared directly on one route", async () => {
    await mkdir(path.join(appDir, "about"), { recursive: true });
    await writeFile(
      path.join(appDir, "about", "page.tsx"),
      `export default function About() { return <section id="hero"><h1>About us</h1></section>; }`,
    );
    const report = await runScan({ appDir, projectRoot: root, full: true });
    expect(report.staticContentCandidates).toHaveLength(1);
    const candidate = report.staticContentCandidates![0]!;
    expect(candidate.scope).toBe("page-section");
    expect(candidate.proposedKey).toBe("about.hero");
    expect(candidate.pageKey).toBe("about");
    expect(candidate.pageRoute).toBe("/about");
    expect(candidate.usedOnRoutes).toEqual(["/about"]);
  });

  it("proposes a top-level singleton for static content in a component shared across routes", async () => {
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
    expect(candidate.proposedKey).toBe("footer");
    expect(candidate.usedOnRoutes.sort()).toEqual(["/about", "/contact"]);
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

  it("notes where a cross-file candidate's array is actually declared", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cimisy-print-cross-file-"));
    const appDir = path.join(root, "app");
    await mkdir(path.join(appDir, "data"), { recursive: true });
    await writeFile(path.join(appDir, "data", "leadership.js"), `export const leaders = [{ name: "A" }];`);
    await mkdir(path.join(appDir, "components"), { recursive: true });
    await writeFile(
      path.join(appDir, "components", "LeadershipGrid.jsx"),
      `
        import { leaders } from "../data/leadership";
        export function LeadershipGrid() { return <div>{leaders.map(l => <p key={l.name} />)}</div>; }
      `,
    );
    await writeFile(
      path.join(appDir, "page.js"),
      `
        import { LeadershipGrid } from "./components/LeadershipGrid";
        export default function Page() { return <LeadershipGrid />; }
      `,
    );
    const report = await runScan({ appDir, projectRoot: root });
    const text = printScanReport(report);
    expect(text).toContain("components/LeadershipGrid.jsx, declared in data/leadership.js");
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
