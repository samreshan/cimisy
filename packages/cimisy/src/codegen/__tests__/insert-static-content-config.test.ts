import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findStaticContent } from "../../scan/analyze-static-content.js";
import { inferStaticSchema } from "../../scan/infer-static-schema.js";
import { insertSectionIntoPageConfig, insertSingletonIntoConfig } from "../insert-static-content-config.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages).toEqual([]);
}

function heroProposal() {
  const source = `export default function Home() { return <section id="hero"><h1>Welcome</h1><p>Subtitle</p></section>; }`;
  const { staticContent } = findStaticContent(source, "/app/page.tsx");
  return inferStaticSchema(staticContent[0]!);
}

const BASE_CONFIG = [
  `import { collection, config, fields } from "cimisy/config";`,
  `import { localSource } from "cimisy/adapters/local";`,
  ``,
  `export default config({`,
  `  source: localSource({ rootDir: "./content" }),`,
  ``,
  `  collections: {},`,
  `});`,
  ``,
].join("\n");

describe("insertSingletonIntoConfig", () => {
  it("creates a `singletons: {...}` object when none exists yet", () => {
    const result = insertSingletonIntoConfig(BASE_CONFIG, {
      name: "footer",
      label: "Footer",
      path: "content/footer.yaml",
      proposal: heroProposal(),
    });
    assertNoSyntaxErrors(result);
    expect(result).toContain("singletons: {");
    expect(result).toContain("footer: singleton({");
    expect(result).toContain('path: "content/footer.yaml"');
    expect(result).toContain('import { collection, config, fields, singleton, blocks } from "cimisy/config";');
  });

  it("inserts a second singleton into an existing singletons object without disturbing the first", () => {
    const withFirst = insertSingletonIntoConfig(BASE_CONFIG, {
      name: "footer",
      label: "Footer",
      path: "content/footer.yaml",
      proposal: heroProposal(),
    });
    const result = insertSingletonIntoConfig(withFirst, {
      name: "header",
      label: "Header",
      path: "content/header.yaml",
      proposal: heroProposal(),
    });
    assertNoSyntaxErrors(result);
    expect(result).toContain("footer: singleton({");
    expect(result).toContain("header: singleton({");
  });

  it("refuses a name collision with an existing collection", () => {
    const configWithCollection = BASE_CONFIG.replace("collections: {}", `collections: { footer: collection({ path: "footer/*.mdx" }) }`);
    expect(() =>
      insertSingletonIntoConfig(configWithCollection, { name: "footer", label: "Footer", path: "content/footer.yaml", proposal: heroProposal() }),
    ).toThrow(/already has a collection named "footer"/);
  });
});

describe("insertSectionIntoPageConfig", () => {
  it("creates `pages: {...}` with the page and section together when no pages property exists", () => {
    const result = insertSectionIntoPageConfig(BASE_CONFIG, {
      pageKey: "home",
      pageLabel: "Home",
      pageRoute: "/",
      pagePath: "content/pages/home",
      sectionKey: "hero",
      sectionLabel: "Hero",
      proposal: heroProposal(),
    });
    assertNoSyntaxErrors(result);
    expect(result).toContain("pages: {");
    expect(result).toContain("home: page({");
    expect(result).toContain('route: "/"');
    expect(result).toContain("sections: {");
    expect(result).toContain("hero: section({");
  });

  it("inserts a second section into a page created earlier in the same run", () => {
    const withFirst = insertSectionIntoPageConfig(BASE_CONFIG, {
      pageKey: "home",
      pageLabel: "Home",
      pageRoute: "/",
      pagePath: "content/pages/home",
      sectionKey: "hero",
      sectionLabel: "Hero",
      proposal: heroProposal(),
    });
    const result = insertSectionIntoPageConfig(withFirst, {
      pageKey: "home",
      pageLabel: "Home",
      pageRoute: "/",
      pagePath: "content/pages/home",
      sectionKey: "cta",
      sectionLabel: "Cta",
      proposal: heroProposal(),
    });
    assertNoSyntaxErrors(result);
    // exactly one `home: page({` — the second call found and extended the existing page rather than redeclaring it
    expect((result.match(/home: page\(\{/g) ?? []).length).toBe(1);
    expect(result).toContain("hero: section({");
    expect(result).toContain("cta: section({");
  });

  it("refuses a section name collision on the same page", () => {
    const withFirst = insertSectionIntoPageConfig(BASE_CONFIG, {
      pageKey: "home",
      pageLabel: "Home",
      pageRoute: "/",
      pagePath: "content/pages/home",
      sectionKey: "hero",
      sectionLabel: "Hero",
      proposal: heroProposal(),
    });
    expect(() =>
      insertSectionIntoPageConfig(withFirst, {
        pageKey: "home",
        pageLabel: "Home",
        pageRoute: "/",
        pagePath: "content/pages/home",
        sectionKey: "hero",
        sectionLabel: "Hero again",
        proposal: heroProposal(),
      }),
    ).toThrow(/already has a section named "hero"/);
  });

  it("refuses a page-key collision with an existing collection", () => {
    const configWithCollection = BASE_CONFIG.replace("collections: {}", `collections: { home: collection({ path: "home/*.mdx" }) }`);
    expect(() =>
      insertSectionIntoPageConfig(configWithCollection, {
        pageKey: "home",
        pageLabel: "Home",
        pageRoute: "/",
        pagePath: "content/pages/home",
        sectionKey: "hero",
        sectionLabel: "Hero",
        proposal: heroProposal(),
      }),
    ).toThrow(/already has a collection named "home"/);
  });
});
