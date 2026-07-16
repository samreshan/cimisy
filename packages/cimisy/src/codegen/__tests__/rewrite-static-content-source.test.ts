import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findStaticContent } from "../../scan/analyze-static-content.js";
import { inferStaticSchema } from "../../scan/infer-static-schema.js";
import { rewriteStaticContentSource } from "../rewrite-static-content-source.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages).toEqual([]);
}

function scanAndInfer(sourceText: string) {
  const { staticContent } = findStaticContent(sourceText, "/project/src/app/page.tsx");
  const candidate = staticContent[0]!;
  const proposal = inferStaticSchema(candidate);
  return { candidate, proposal };
}

describe("rewriteStaticContentSource", () => {
  it("replaces a heading's text, makes the function async, and adds the required imports", () => {
    const sourceText = `export default function Home() {
  return (
    <section id="hero">
      <h1>Welcome</h1>
    </section>
  );
}
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "heroContent",
      readerPath: { kind: "page-section", pageKey: "home", sectionKey: "hero" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });

    assertNoSyntaxErrors(result);
    expect(result).not.toContain("Welcome");
    expect(result).toContain("{heroContent.heading}");
    expect(result).toContain('(cimisyReader.pages.home.hero as import("cimisy/next").SingletonReader).get()');
    expect(result).toContain("export default async function Home()");
    expect(result).toContain('import { createReader } from "cimisy/next";');
    expect(result).toContain('import cimisyConfig from "../../cimisy.config";');
  });

  it("swaps an image's src/alt for reads, inserting a new alt attribute when one was absent", () => {
    const sourceText = `export default function Home() {
  return <section id="hero"><img src="/hero.jpg" /></section>;
}
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "heroContent",
      readerPath: { kind: "page-section", pageKey: "home", sectionKey: "hero" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });

    assertNoSyntaxErrors(result);
    expect(result).not.toContain("/hero.jpg");
    expect(result).toContain('src={heroContent.image ?? ""}');
    expect(result).toContain('alt={heroContent["image-alt"]}');
  });

  it("replaces an already-present alt attribute in place rather than inserting a duplicate", () => {
    const sourceText = `export default function Home() {
  return <section id="hero"><img src="/hero.jpg" alt="Hero shot" /></section>;
}
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "heroContent",
      readerPath: { kind: "page-section", pageKey: "home", sectionKey: "hero" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });
    assertNoSyntaxErrors(result);
    expect((result.match(/alt=/g) ?? []).length).toBe(1);
    expect(result).toContain('alt={heroContent["image-alt"]}');
    expect(result).not.toContain("Hero shot");
  });

  it("merges two paragraphs into one renderBlocks() call, removing the second element entirely", () => {
    const sourceText = `export default function Home() {
  return (
    <section id="hero">
      <p>First</p>
      <p>Second</p>
    </section>
  );
}
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "heroContent",
      readerPath: { kind: "page-section", pageKey: "home", sectionKey: "hero" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });

    assertNoSyntaxErrors(result);
    expect(result).not.toContain("First");
    expect(result).not.toContain("Second");
    expect((result.match(/renderBlocks\(heroContent\.body\)/g) ?? []).length).toBe(1);
    expect((result.match(/<p>/g) ?? []).length).toBe(0);
    expect(result).toContain('import { renderBlocks } from "cimisy/render";');
  });

  it("splits a standalone CTA link into label/href reads", () => {
    const sourceText = `export default function Home() {
  return <section id="cta"><a href="/contact">Contact us</a></section>;
}
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "ctaContent",
      readerPath: { kind: "page-section", pageKey: "home", sectionKey: "cta" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });

    assertNoSyntaxErrors(result);
    expect(result).toContain('{ctaContent["cta-label"]}');
    expect(result).toContain('href={ctaContent["cta-href"] ?? ""}');
    expect(result).not.toContain("Contact us");
  });

  it("wraps a concise-arrow-body component into a block, preserving the original JSX shape around the rewritten field", () => {
    const sourceText = `const Home = () => <section id="hero"><h1>Welcome</h1></section>;
export default Home;
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "heroContent",
      readerPath: { kind: "singleton", key: "hero" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });

    assertNoSyntaxErrors(result);
    expect(result).toContain("const Home = async () => {");
    expect(result).toContain("cimisyReader.singletons.hero.get()");
    expect(result).toContain('return <section id="hero">{heroContent.heading}</section>;'.replace("{heroContent.heading}", "<h1>{heroContent.heading}</h1>"));
  });

  it("uses reader.singletons.<key>.get() for a top-level singleton reader path", () => {
    const sourceText = `export default function Footer() {
  return <footer id="footer"><span>All rights reserved</span></footer>;
}
`;
    const { candidate, proposal } = scanAndInfer(sourceText);
    const result = rewriteStaticContentSource({
      sourceText,
      filePath: "/project/src/components/Footer.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "footerContent",
      readerPath: { kind: "singleton", key: "footer" },
      fields: candidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: candidate.regionStart,
    });
    assertNoSyntaxErrors(result);
    expect(result).toContain("cimisyReader.singletons.footer.get()");
    expect(result).toContain("{footerContent.label}");
  });

  it("anchors a second candidate's fetch after an existing cimisyReader bootstrap, not before it (TDZ regression)", () => {
    // Simulates the state after a first candidate ("hero") was already applied to this function — plus a
    // second, not-yet-rewritten region ("cta") sharing the same function, which is what the next
    // rewriteStaticContentSource call targets.
    const withSecondRegion = `export default async function Home() {
  const cimisyReader = createReader(cimisyConfig);
  const heroContent = ((await cimisyReader.pages.home.hero.get())?.values as { heading: string }) ?? { heading: "" };
  return (
    <>
      <section id="hero">
        <h1>{heroContent.heading}</h1>
      </section>
      <section id="cta"><a href="/contact">Contact us</a></section>
    </>
  );
}
`;
    const { staticContent } = findStaticContent(withSecondRegion, "/project/src/app/page.tsx");
    const ctaCandidate = staticContent.find((c) => c.regionHint === "cta")!;
    const proposal = inferStaticSchema(ctaCandidate);

    const result = rewriteStaticContentSource({
      sourceText: withSecondRegion,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: "ctaContent",
      readerPath: { kind: "page-section", pageKey: "home", sectionKey: "cta" },
      fields: ctaCandidate.fields,
      fieldAssignments: proposal.fieldAssignments,
      proposalFields: proposal.fields,
      anchorPos: ctaCandidate.regionStart,
    });

    assertNoSyntaxErrors(result);
    // exactly one bootstrap — not re-declared
    expect((result.match(/const cimisyReader = createReader/g) ?? []).length).toBe(1);
    // and it comes before both fetches that use it
    const bootstrapPos = result.indexOf("const cimisyReader = createReader");
    const heroUse = result.indexOf("cimisyReader.pages.home.hero");
    const ctaUse = result.indexOf("cimisyReader.pages.home.cta");
    expect(bootstrapPos).toBeLessThan(heroUse);
    expect(bootstrapPos).toBeLessThan(ctaUse);
  });
});
