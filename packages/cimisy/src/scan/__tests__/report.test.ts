import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultReportPath, formatScanSummaryLine, loadScanReport, printScanReport, runScan, saveScanReport, scanFindingsExitCode, toPortableReport, type ScanReport } from "../report.js";

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

  it('never offers a "use client" component\'s array for import — createReader is server-only', async () => {
    await mkdir(path.join(root, "src", "components"), { recursive: true });
    await writeFile(
      path.join(root, "src", "components", "Nav.jsx"),
      `
        "use client";
        const links = [{ label: "Home", href: "/" }, { label: "About", href: "/about" }];
        export function Nav() { return <nav>{links.map(l => <a key={l.href} href={l.href}>{l.label}</a>)}</nav>; }
      `,
    );
    await writeFile(
      path.join(appDir, "page.tsx"),
      `import { Nav } from "@/components/Nav"; export default function Page() { return <Nav />; }`,
    );

    const report = await runScan({ appDir, projectRoot: root, pathAliases: { "@/*": "./src/*" } });
    expect(report.collectionCandidates).toEqual([]);
    expect(report.unanalyzable).toHaveLength(1);
    expect(report.unanalyzable[0]!.variableName).toBe("links");
    expect(report.unanalyzable[0]!.reason).toMatch(/Client Component/);
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

  it("does not analyze page metadata by default (full: false)", async () => {
    await writeFile(
      path.join(appDir, "page.tsx"),
      `export const metadata = { title: "Home" }; export default function Home() { return <div />; }`,
    );
    const report = await runScan({ appDir, projectRoot: root });
    expect(report.pageMetadataCandidates).toEqual([]);
    expect(report.pageMetadataUnanalyzable).toEqual([]);
  });

  it("reports a page's export const metadata, tagged with its route", async () => {
    await mkdir(path.join(appDir, "careers"), { recursive: true });
    await writeFile(
      path.join(appDir, "careers", "page.tsx"),
      `
        export const metadata = {
          title: "Careers",
          description: "Join a small, senior team.",
          openGraph: { title: "Careers", description: "Join a small, senior team.", url: "/careers" },
        };
        export default function Careers() { return <div />; }
      `,
    );
    const report = await runScan({ appDir, projectRoot: root, full: true });
    expect(report.pageMetadataCandidates).toHaveLength(1);
    const candidate = report.pageMetadataCandidates![0]!;
    expect(candidate.routePath).toBe("/careers");
    expect(candidate.title).toBe("Careers");
    expect(candidate.description).toBe("Join a small, senior team.");
    expect(candidate.canonical).toBe("/careers");
  });

  it("reports a page's non-literal metadata as unanalyzable", async () => {
    await writeFile(
      path.join(appDir, "page.tsx"),
      `export const metadata = { title: getTitle() }; export default function Home() { return <div />; }`,
    );
    const report = await runScan({ appDir, projectRoot: root, full: true });
    expect(report.pageMetadataCandidates).toEqual([]);
    expect(report.pageMetadataUnanalyzable).toHaveLength(1);
    expect(report.pageMetadataUnanalyzable![0]!.routePath).toBe("/");
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

  it("prints page metadata candidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cimisy-print-metadata-"));
    const appDir = path.join(root, "app");
    await mkdir(path.join(appDir, "careers"), { recursive: true });
    await writeFile(
      path.join(appDir, "careers", "page.tsx"),
      `export const metadata = { title: "Careers", description: "Join us" }; export default function Careers() { return <div />; }`,
    );
    const report = await runScan({ appDir, projectRoot: root, full: true });
    const text = printScanReport(report);
    expect(text).toContain("Page metadata candidates:");
    expect(text).toContain("/careers");
    expect(text).toContain('title: "Careers"');
    expect(text).toContain('description: "Join us"');
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

describe("runScan — scan modes and whole-site entrypoints (v2.3)", () => {
  let root: string;
  let appDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-report-v23-"));
    appDir = path.join(root, "src", "app");
    await mkdir(appDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, text: string): Promise<void> {
    const full = path.join(appDir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }

  const LAYOUT_WITH_FOOTER = `
    export const metadata = { title: "Site" };
    export default function RootLayout({ children }) {
      return (
        <html><body>
          {children}
          <footer id="site-footer">
            <h2>Contact us</h2>
            <p>Reach us at our office.</p>
          </footer>
        </body></html>
      );
    }
  `;

  const PAGE_WITH_METADATA = `
    export const metadata = { title: "About", description: "Who we are" };
    export default function AboutPage() { return <main><h1>About heading</h1><p>About body text.</p></main>; }
  `;

  it("collections mode scans neither static content nor metadata; the report records mode + version", async () => {
    await write("layout.tsx", LAYOUT_WITH_FOOTER);
    await write("about/page.tsx", PAGE_WITH_METADATA);
    await write("page.tsx", `export default function Home() { return <main><h1>Home</h1><p>Welcome text.</p></main>; }`);

    const report = await runScan({ appDir, projectRoot: root, mode: "collections" });
    expect(report.mode).toBe("collections");
    expect(report.reportVersion).toBe(1);
    expect(report.staticContentCandidates).toEqual([]);
    expect(report.pageMetadataCandidates).toEqual([]);
  });

  it("collections-metadata mode scans metadata but not static content", async () => {
    await write("about/page.tsx", PAGE_WITH_METADATA);
    const report = await runScan({ appDir, projectRoot: root, mode: "collections-metadata" });
    expect(report.pageMetadataCandidates).toHaveLength(1);
    expect(report.pageMetadataCandidates![0]!.pageKey).toBe("about");
    expect(report.staticContentCandidates).toEqual([]);
  });

  it("static mode scans static content but not metadata", async () => {
    await write("about/page.tsx", PAGE_WITH_METADATA);
    const report = await runScan({ appDir, projectRoot: root, mode: "static" });
    expect(report.pageMetadataCandidates).toEqual([]);
    expect(report.staticContentCandidates!.length).toBeGreaterThan(0);
  });

  it("full:true still behaves as the static-metadata alias", async () => {
    await write("about/page.tsx", PAGE_WITH_METADATA);
    const report = await runScan({ appDir, projectRoot: root, full: true });
    expect(report.mode).toBe("static-metadata");
    expect(report.pageMetadataCandidates).toHaveLength(1);
    expect(report.staticContentCandidates!.length).toBeGreaterThan(0);
  });

  it("a layout-owned region is always a top-level singleton spanning its subtree's routes — even with one page", async () => {
    await write("layout.tsx", LAYOUT_WITH_FOOTER);
    await write("page.tsx", `export default function Home() { return <main>home</main>; }`);

    const report = await runScan({ appDir, projectRoot: root, mode: "static-metadata" });
    const footer = report.staticContentCandidates!.find((c) => c.regionHint.includes("footer"));
    expect(footer).toBeDefined();
    expect(footer!.scope).toBe("top-level-singleton");
    expect(footer!.usedOnRoutes).toEqual(["/"]);
    expect(footer!.section).toBe("layout");

    // With a second page, the layout spans both routes.
    await write("about/page.tsx", `export default function About() { return <main>about</main>; }`);
    const report2 = await runScan({ appDir, projectRoot: root, mode: "static-metadata" });
    const footer2 = report2.staticContentCandidates!.find((c) => c.regionHint.includes("footer"));
    expect(footer2!.usedOnRoutes.sort()).toEqual(["/", "/about"]);
  });

  it("layout metadata is reported as unanalyzable (site-wide, not per-page importable)", async () => {
    await write("layout.tsx", LAYOUT_WITH_FOOTER);
    await write("page.tsx", `export default function Home() { return <main>home</main>; }`);

    const report = await runScan({ appDir, projectRoot: root, mode: "collections-metadata" });
    expect(report.pageMetadataCandidates).toEqual([]);
    expect(report.pageMetadataUnanalyzable).toHaveLength(1);
    expect(report.pageMetadataUnanalyzable![0]!.reason).toContain("layout-level metadata");
  });

  it("records an entrypoints summary and keeps `pages` page-only", async () => {
    await write("layout.tsx", LAYOUT_WITH_FOOTER);
    await write("page.tsx", `export default function Home() { return <main>home</main>; }`);
    await write("about/page.tsx", `export default function About() { return <main>about</main>; }`);

    const report = await runScan({ appDir, projectRoot: root, mode: "collections" });
    expect(report.pages.map((p) => p.routePath).sort()).toEqual(["/", "/about"]);
    const layout = report.entrypoints!.find((e) => e.kind === "layout")!;
    expect(layout.routes.sort()).toEqual(["/", "/about"]);
  });

  it("a layout whose subtree has no pages is skipped entirely", async () => {
    await write("empty/layout.tsx", LAYOUT_WITH_FOOTER);
    await write("page.tsx", `export default function Home() { return <main>home</main>; }`);

    const report = await runScan({ appDir, projectRoot: root, mode: "static-metadata" });
    expect(report.entrypoints!.some((e) => e.kind === "layout")).toBe(false);
    expect(report.staticContentCandidates!.some((c) => c.regionHint.includes("footer"))).toBe(false);
  });

  it("strips @slot segments from route derivation", async () => {
    await write("dash/@sidebar/page.tsx", `export default function Sidebar() { return <aside>side</aside>; }`);
    await write("dash/page.tsx", `export default function Dash() { return <main>dash</main>; }`);

    const report = await runScan({ appDir, projectRoot: root, mode: "collections" });
    expect([...new Set(report.pages.map((p) => p.routePath))]).toEqual(["/dash"]);
  });
});

describe("CI helpers — portable report and exit codes", () => {
  const base: ScanReport = {
    reportVersion: 1,
    mode: "static-metadata",
    generatedAt: "2026-07-16T00:00:00.000Z",
    appDir: "/proj/src/app",
    pages: [{ pagePath: "/proj/src/app/page.tsx", routePath: "/" }],
    entrypoints: [{ filePath: "/proj/src/app/layout.tsx", kind: "layout", routes: ["/"] }],
    collectionCandidates: [],
    unanalyzable: [],
    staticContentCandidates: [],
    staticUnanalyzable: [],
    pageMetadataCandidates: [],
    pageMetadataUnanalyzable: [],
  };

  it("toPortableReport rewrites every path project-root-relative with posix separators", () => {
    const portable = toPortableReport(
      {
        ...base,
        unanalyzable: [
          { variableName: "x", sourceFile: "/proj/src/app/page.tsx", declarationFile: "/proj/src/data/x.ts", section: "page", reason: "r", usedOnRoutes: ["/"] },
        ],
      },
      "/proj",
    );
    expect(portable.appDir).toBe("src/app");
    expect(portable.pages[0]!.pagePath).toBe("src/app/page.tsx");
    expect(portable.entrypoints![0]!.filePath).toBe("src/app/layout.tsx");
    expect(portable.unanalyzable[0]!.sourceFile).toBe("src/app/page.tsx");
    expect(portable.unanalyzable[0]!.declarationFile).toBe("src/data/x.ts");
  });

  it("exit code is 0 only when there are no candidates AND no unanalyzable detections", () => {
    expect(scanFindingsExitCode(base)).toBe(0);
    expect(
      scanFindingsExitCode({
        ...base,
        pageMetadataUnanalyzable: [{ sourceFile: "/f", routePath: "/", reason: "r", nodeStart: 0, nodeEnd: 1 }],
      }),
    ).toBe(1);
    expect(
      scanFindingsExitCode({
        ...base,
        pageMetadataCandidates: [{ sourceFile: "/f", routePath: "/", title: "t", nodeStart: 0, nodeEnd: 1 }],
      }),
    ).toBe(1);
  });

  it("formatScanSummaryLine names each bucket", () => {
    const line = formatScanSummaryLine(base);
    expect(line).toContain("static-metadata");
    expect(line).toContain("0 collection candidate(s), 0 static, 0 metadata, 0 not import-eligible");
  });
});
