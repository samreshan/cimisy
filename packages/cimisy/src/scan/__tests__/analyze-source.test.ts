import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findJsxSections, findRepeatingContent } from "../analyze-source.js";

describe("findRepeatingContent", () => {
  it("detects an inline array-of-object-literals that's later .map()'d in the same file (SIA's news page shape)", async () => {
    const source = `
      const articles = [
        { title: "Sunflower Institute Featured in TechPana", date: "April 2026", category: "Press" },
        { title: "Nepal Needs a Constructive Nationwide System for Autism", date: "March 2026", category: "Advocacy" },
      ];

      export default function NewsPage() {
        return <div>{articles.map((a, i) => <Card key={i} title={a.title} />)}</div>;
      }
    `;
    const result = await findRepeatingContent(source, "/app/news/page.tsx");

    expect(result.unanalyzable).toEqual([]);
    expect(result.repeatingContent).toHaveLength(1);
    const candidate = result.repeatingContent[0]!;
    expect(candidate.variableName).toBe("articles");
    expect(candidate.declarationFile).toBe("/app/news/page.tsx");
    expect(candidate.items).toEqual([
      { title: "Sunflower Institute Featured in TechPana", date: "April 2026", category: "Press" },
      { title: "Nepal Needs a Constructive Nationwide System for Autism", date: "March 2026", category: "Advocacy" },
    ]);
    // declaration span should cover exactly the `const articles = [...]` statement
    expect(source.slice(candidate.declarationStart, candidate.declarationEnd)).toContain("const articles = [");
    expect(source.slice(candidate.declarationStart, candidate.declarationEnd)).not.toContain("NewsPage");
  });

  it("supports nested array-of-strings fields (SIA's vacancies `requirements` shape)", async () => {
    const source = `
      const vacancies = [
        { title: "ABA Therapist", requirements: ["Bachelors in Psychology", "Strong communication skills"] },
      ];
      const rendered = vacancies.map(v => <li>{v.title}</li>);
    `;
    const result = await findRepeatingContent(source, "/app/careers/page.tsx");
    expect(result.repeatingContent).toHaveLength(1);
    expect(result.repeatingContent[0]!.items[0]!.requirements).toEqual([
      "Bachelors in Psychology",
      "Strong communication skills",
    ]);
  });

  it("ignores arrays that are never .map()'d — not every array is content", async () => {
    const source = `
      const ALLOWED_LANGUAGES = ["ts", "js", "bash"];
      const unused = [{ a: 1 }, { a: 2 }];
      export default function Page() { return <div />; }
    `;
    const result = await findRepeatingContent(source, "/app/page.tsx");
    expect(result.repeatingContent).toEqual([]);
    expect(result.unanalyzable).toEqual([]);
  });

  it("reports (but does not offer) arrays whose items contain non-literal values", async () => {
    const source = `
      const articles = [
        { title: "A", author: getCurrentUser() },
        { title: "B", author: "static" },
      ];
      const rendered = articles.map(a => <p>{a.title}</p>);
    `;
    const result = await findRepeatingContent(source, "/app/news/page.tsx");
    expect(result.repeatingContent).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.variableName).toBe("articles");
    expect(result.unanalyzable[0]!.reason).toMatch(/not a literal value/);
  });

  it("reports arrays containing a spread as unanalyzable", async () => {
    const source = `
      const base = { category: "Press" };
      const articles = [ { ...base, title: "A" } ];
      const rendered = articles.map(a => <p>{a.title}</p>);
    `;
    const result = await findRepeatingContent(source, "/app/news/page.tsx");
    expect(result.repeatingContent).toEqual([]);
    expect(result.unanalyzable[0]!.reason).toMatch(/spread/);
  });

  it("reports non-object-literal array elements as unanalyzable", async () => {
    const source = `
      const tags = ["a", "b", "c"];
      const rendered = tags.map(t => <span>{t}</span>);
    `;
    const result = await findRepeatingContent(source, "/app/page.tsx");
    expect(result.repeatingContent).toEqual([]);
    expect(result.unanalyzable[0]!.reason).toMatch(/not an object literal/);
  });

  it("finds multiple independent candidates in one file", async () => {
    const source = `
      const partners = [{ name: "Allora" }, { name: "Codeavatar" }];
      const vacancies = [{ title: "ABA Therapist" }];
      export default function Page() {
        return (
          <>
            {partners.map(p => <img key={p.name} alt={p.name} />)}
            {vacancies.map(v => <li key={v.title}>{v.title}</li>)}
          </>
        );
      }
    `;
    const result = await findRepeatingContent(source, "/app/page.tsx");
    expect(result.repeatingContent.map((c) => c.variableName).sort()).toEqual(["partners", "vacancies"]);
  });

  describe("cross-file resolution (array declared in a separate data module)", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "cimisy-cross-file-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("follows a plain named import back to its exported array declaration (leadership.js shape)", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      const dataFile = path.join(root, "data", "leadership.js");
      await writeFile(
        dataFile,
        `export const leaders = [\n  { name: "A", title: "CEO" },\n  { name: "B", title: "COO" },\n];\n`,
      );
      const componentFile = path.join(root, "components", "LeadershipGrid.jsx");
      await mkdir(path.dirname(componentFile), { recursive: true });
      const componentSource = `
        import { leaders } from "../data/leadership";
        export function LeadershipGrid() {
          return <div>{leaders.map((member) => <Card key={member.name} name={member.name} />)}</div>;
        }
      `;

      const result = await findRepeatingContent(componentSource, componentFile);

      expect(result.unanalyzable).toEqual([]);
      expect(result.repeatingContent).toHaveLength(1);
      const candidate = result.repeatingContent[0]!;
      expect(candidate.variableName).toBe("leaders");
      expect(candidate.sourceFile).toBe(componentFile);
      expect(candidate.declarationFile).toBe(dataFile);
      expect(candidate.items).toEqual([
        { name: "A", title: "CEO" },
        { name: "B", title: "COO" },
      ]);

      const dataText = await readFile(dataFile, "utf8");
      expect(dataText.slice(candidate.declarationStart, candidate.declarationEnd)).toContain("export const leaders = [");
    });

    it("supports an aliased named import (`import { leaders as team }`)", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      const dataFile = path.join(root, "data", "leadership.js");
      await writeFile(dataFile, `export const leaders = [{ name: "A" }];\n`);
      const componentFile = path.join(root, "Grid.jsx");
      const componentSource = `
        import { leaders as team } from "./data/leadership";
        export function Grid() { return <div>{team.map(t => <p key={t.name}>{t.name}</p>)}</div>; }
      `;
      const result = await findRepeatingContent(componentSource, componentFile);
      expect(result.repeatingContent).toHaveLength(1);
      expect(result.repeatingContent[0]!.variableName).toBe("team");
      expect(result.repeatingContent[0]!.declarationFile).toBe(dataFile);
    });

    it("reports a cross-file array as unanalyzable (not silently dropped) when its items aren't literal objects", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      const dataFile = path.join(root, "data", "leadership.js");
      await writeFile(dataFile, `export const leaders = ["A", "B"];\n`);
      const componentFile = path.join(root, "Grid.jsx");
      const componentSource = `
        import { leaders } from "./data/leadership";
        export function Grid() { return <div>{leaders.map(l => <p key={l}>{l}</p>)}</div>; }
      `;
      const result = await findRepeatingContent(componentSource, componentFile);
      expect(result.repeatingContent).toEqual([]);
      expect(result.unanalyzable).toHaveLength(1);
      expect(result.unanalyzable[0]!.variableName).toBe("leaders");
      expect(result.unanalyzable[0]!.declarationFile).toBe(dataFile);
      expect(result.unanalyzable[0]!.reason).toMatch(/not an object literal/);
    });

    it("leaves a default-imported array unresolved rather than guessing (named-import following only)", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(path.join(root, "data", "leadership.js"), `export default [{ name: "A" }];\n`);
      const componentFile = path.join(root, "Grid.jsx");
      const componentSource = `
        import leaders from "./data/leadership";
        export function Grid() { return <div>{leaders.map(l => <p key={l.name}>{l.name}</p>)}</div>; }
      `;
      const result = await findRepeatingContent(componentSource, componentFile);
      expect(result.repeatingContent).toEqual([]);
      expect(result.unanalyzable).toEqual([]);
    });

    it("does not crash when the import target has no matching exported array", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(path.join(root, "data", "leadership.js"), `export const somethingElse = 42;\n`);
      const componentFile = path.join(root, "Grid.jsx");
      const componentSource = `
        import { leaders } from "./data/leadership";
        export function Grid() { return <div>{leaders.map(l => <p key={l.name}>{l.name}</p>)}</div>; }
      `;
      const result = await findRepeatingContent(componentSource, componentFile);
      expect(result.repeatingContent).toEqual([]);
      expect(result.unanalyzable).toEqual([]);
    });
  });
});

describe("findJsxSections", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-jsx-sections-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a relative-import component to its file on disk", async () => {
    await mkdir(path.join(root, "components"), { recursive: true });
    await writeFile(path.join(root, "components", "HomeHero.tsx"), "export function HomeHero() { return null; }");
    const pagePath = path.join(root, "page.tsx");
    const pageSource = `
      import { HomeHero } from "./components/HomeHero";
      export default function Page() { return <HomeHero />; }
    `;

    const sections = await findJsxSections(pageSource, pagePath);
    expect(sections).toEqual([{ componentName: "HomeHero", sourceFile: path.join(root, "components", "HomeHero.tsx") }]);
  });

  it("resolves a tsconfig-style path-alias import (SIA's \"@/*\" -> \"./src/*\")", async () => {
    await mkdir(path.join(root, "src", "components"), { recursive: true });
    await writeFile(path.join(root, "src", "components", "Navbar.tsx"), "export function Navbar() { return null; }");
    const pagePath = path.join(root, "src", "app", "page.tsx");
    await mkdir(path.dirname(pagePath), { recursive: true });
    const pageSource = `
      import { Navbar } from "@/components/Navbar";
      export default function Page() { return <Navbar />; }
    `;

    const sections = await findJsxSections(pageSource, pagePath, { pathAliases: { "@/*": "./src/*" }, projectRoot: root });
    expect(sections).toEqual([{ componentName: "Navbar", sourceFile: path.join(root, "src", "components", "Navbar.tsx") }]);
  });

  it("leaves package-imported components unresolved (sourceFile: null)", async () => {
    const pagePath = path.join(root, "page.tsx");
    const pageSource = `
      import { AnimatePresence } from "framer-motion";
      export default function Page() { return <AnimatePresence />; }
    `;
    const sections = await findJsxSections(pageSource, pagePath);
    expect(sections).toEqual([{ componentName: "AnimatePresence", sourceFile: null }]);
  });

  it("resolves a relative-import .jsx component (plain-JavaScript App Router project)", async () => {
    await mkdir(path.join(root, "components"), { recursive: true });
    await writeFile(path.join(root, "components", "HomeHero.jsx"), "export function HomeHero() { return null; }");
    const pagePath = path.join(root, "page.js");
    const pageSource = `
      import { HomeHero } from "./components/HomeHero";
      export default function Page() { return <HomeHero />; }
    `;

    const sections = await findJsxSections(pageSource, pagePath);
    expect(sections).toEqual([{ componentName: "HomeHero", sourceFile: path.join(root, "components", "HomeHero.jsx") }]);
  });
});
