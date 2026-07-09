import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findRepeatingContent } from "../../scan/analyze-source.js";
import { inferSchema } from "../../scan/infer-schema.js";
import { rewriteArraySource } from "../rewrite-array-source.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages).toEqual([]);
}

describe("rewriteArraySource", () => {
  it("swaps SIA's news-page array for a same-shape fetch, leaving the JSX/map body untouched", () => {
    const sourceText = `import React from "react";

const articles = [
  { title: "A", date: "April 2026", category: "Press" },
  { title: "B", date: "March 2026", category: "Advocacy" },
];

export default function NewsPage() {
  return <div>{articles.map((a, i) => <Card key={i} title={a.title} date={a.date} category={a.category} />)}</div>;
}
`;
    const { repeatingContent } = findRepeatingContent(sourceText, "/app/news/page.tsx");
    expect(repeatingContent).toHaveLength(1);
    const candidate = repeatingContent[0]!;

    const result = rewriteArraySource({
      sourceText,
      filePath: "/project/src/app/news/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: candidate.variableName,
      collectionName: "news",
      fields: inferSchema(candidate.items).fields,
      declarationStart: candidate.declarationStart,
      declarationEnd: candidate.declarationEnd,
      mapCallStart: candidate.mapCallStart,
    });

    assertNoSyntaxErrors(result);
    // the array literal itself is gone
    expect(result).not.toContain('{ title: "A"');
    // replaced with a same-shape fetch, cast back to the shape the pre-existing JSX already expects
    expect(result).toContain(
      "const articles = (await cimisyReader.collections.news.all()).map((entry) => entry.values as { title: string; date: string; category: string });",
    );
    // the JSX/map callback body is byte-for-byte untouched
    expect(result).toContain(
      "return <div>{articles.map((a, i) => <Card key={i} title={a.title} date={a.date} category={a.category} />)}</div>;",
    );
    // enclosing function became async
    expect(result).toContain("export default async function NewsPage()");
    // required imports were added
    expect(result).toContain('import { createReader } from "cimisy/next";');
    expect(result).toContain('import cimisyConfig from "../../../cimisy.config";');
  });

  it("does not double-mark an already-async function", () => {
    const sourceText = `
      const items = [{ title: "A" }];
      export default async function Page() {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      }
    `;
    const { repeatingContent } = findRepeatingContent(sourceText, "/app/page.tsx");
    const candidate = repeatingContent[0]!;
    const result = rewriteArraySource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: candidate.variableName,
      collectionName: "items",
      fields: inferSchema(candidate.items).fields,
      declarationStart: candidate.declarationStart,
      declarationEnd: candidate.declarationEnd,
      mapCallStart: candidate.mapCallStart,
    });
    assertNoSyntaxErrors(result);
    expect(result).not.toMatch(/async\s+async/);
    expect((result.match(/async/g) ?? []).length).toBe(1);
  });

  it("handles an arrow-function component", () => {
    const sourceText = `
      const items = [{ title: "A" }];
      const Page = () => {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      };
      export default Page;
    `;
    const { repeatingContent } = findRepeatingContent(sourceText, "/app/page.tsx");
    const candidate = repeatingContent[0]!;
    const result = rewriteArraySource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: candidate.variableName,
      collectionName: "items",
      fields: inferSchema(candidate.items).fields,
      declarationStart: candidate.declarationStart,
      declarationEnd: candidate.declarationEnd,
      mapCallStart: candidate.mapCallStart,
    });
    assertNoSyntaxErrors(result);
    expect(result).toContain("const Page = async () => {");
  });

  it("reuses an existing createReader/cimisyConfig import instead of duplicating it", () => {
    const sourceText = `
      import { createReader } from "cimisy/next";
      import cimisyConfig from "../../cimisy.config";
      const items = [{ title: "A" }];
      export default function Page() {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      }
    `;
    const { repeatingContent } = findRepeatingContent(sourceText, "/app/page.tsx");
    const candidate = repeatingContent[0]!;
    const result = rewriteArraySource({
      sourceText,
      filePath: "/project/src/app/page.tsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: candidate.variableName,
      collectionName: "items",
      fields: inferSchema(candidate.items).fields,
      declarationStart: candidate.declarationStart,
      declarationEnd: candidate.declarationEnd,
      mapCallStart: candidate.mapCallStart,
    });
    assertNoSyntaxErrors(result);
    expect((result.match(/from "cimisy\/next"/g) ?? []).length).toBe(1);
    expect((result.match(/cimisy\.config/g) ?? []).length).toBe(1);
  });
});

describe("rewriteArraySource — refuses to guess", () => {
  it("throws rather than inserting a top-level await when the .map() call isn't inside any function", () => {
    const sourceText = `
      const items = [{ title: "A" }];
      const mapped = items.map((i) => i.title);
    `;
    const { repeatingContent } = findRepeatingContent(sourceText, "/app/data.ts");
    const candidate = repeatingContent[0]!;
    expect(() =>
      rewriteArraySource({
        sourceText,
        filePath: "/project/src/app/data.ts",
        configFilePath: "/project/cimisy.config.ts",
        variableName: candidate.variableName,
        collectionName: "items",
        fields: inferSchema(candidate.items).fields,
        declarationStart: candidate.declarationStart,
        declarationEnd: candidate.declarationEnd,
        mapCallStart: candidate.mapCallStart,
      }),
    ).toThrow(/refusing to insert an `await` outside a function/);
  });
});
