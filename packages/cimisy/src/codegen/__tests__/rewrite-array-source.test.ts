import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("swaps SIA's news-page array for a same-shape fetch, leaving the JSX/map body untouched", async () => {
    const sourceText = `import React from "react";

const articles = [
  { title: "A", date: "April 2026", category: "Press" },
  { title: "B", date: "March 2026", category: "Advocacy" },
];

export default function NewsPage() {
  return <div>{articles.map((a, i) => <Card key={i} title={a.title} date={a.date} category={a.category} />)}</div>;
}
`;
    const { repeatingContent } = await findRepeatingContent(sourceText, "/app/news/page.tsx");
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

  it("does not double-mark an already-async function", async () => {
    const sourceText = `
      const items = [{ title: "A" }];
      export default async function Page() {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      }
    `;
    const { repeatingContent } = await findRepeatingContent(sourceText, "/app/page.tsx");
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

  it("handles an arrow-function component", async () => {
    const sourceText = `
      const items = [{ title: "A" }];
      const Page = () => {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      };
      export default Page;
    `;
    const { repeatingContent } = await findRepeatingContent(sourceText, "/app/page.tsx");
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

  it("reuses an existing createReader/cimisyConfig import instead of duplicating it", async () => {
    const sourceText = `
      import { createReader } from "cimisy/next";
      import cimisyConfig from "../../cimisy.config";
      const items = [{ title: "A" }];
      export default function Page() {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      }
    `;
    const { repeatingContent } = await findRepeatingContent(sourceText, "/app/page.tsx");
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

  it("omits the `as {...}` TS type cast when rewriting a plain .jsx file (a valid App Router shape, not just .tsx)", async () => {
    const sourceText = `
      const items = [{ title: "A" }];
      export default function Page() {
        return <div>{items.map(i => <p key={i.title}>{i.title}</p>)}</div>;
      }
    `;
    const { repeatingContent } = await findRepeatingContent(sourceText, "/app/page.jsx");
    const candidate = repeatingContent[0]!;
    const result = rewriteArraySource({
      sourceText,
      filePath: "/project/src/app/page.jsx",
      configFilePath: "/project/cimisy.config.ts",
      variableName: candidate.variableName,
      collectionName: "items",
      fields: inferSchema(candidate.items).fields,
      declarationStart: candidate.declarationStart,
      declarationEnd: candidate.declarationEnd,
      mapCallStart: candidate.mapCallStart,
    });
    expect(result).toContain("const items = (await cimisyReader.collections.items.all()).map((entry) => entry.values);");
    expect(result).not.toContain(" as {");
  });

  describe("cross-file (array declared in a separate data module)", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "cimisy-rewrite-cross-file-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("removes the stale named import instead of a local declaration, leaving the map body untouched", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(path.join(root, "data", "leadership.js"), `export const leaders = [{ name: "A", title: "CEO" }];\n`);
      const componentFile = path.join(root, "components", "LeadershipGrid.jsx");
      await mkdir(path.dirname(componentFile), { recursive: true });
      const sourceText = `import { leaders } from "../data/leadership";

export function LeadershipGrid() {
  return <div>{leaders.map((member) => <Card key={member.name} name={member.name} title={member.title} />)}</div>;
}
`;
      const { repeatingContent } = await findRepeatingContent(sourceText, componentFile);
      expect(repeatingContent).toHaveLength(1);
      const candidate = repeatingContent[0]!;
      expect(candidate.declarationFile).not.toBe(candidate.sourceFile);

      const result = rewriteArraySource({
        sourceText,
        filePath: componentFile,
        configFilePath: path.join(root, "cimisy.config.ts"),
        variableName: candidate.variableName,
        collectionName: "leadership",
        fields: inferSchema(candidate.items).fields,
        mapCallStart: candidate.mapCallStart,
        // declarationStart/declarationEnd deliberately omitted — the array lives in data/leadership.js, not this file.
      });

      assertNoSyntaxErrors(result);
      // stale import of `leaders` is gone (no local declaration to delete instead)
      expect(result).not.toContain("../data/leadership");
      expect(result).not.toContain("leaders }");
      // fetch replaces it, JSX untouched — no `as {...}` TS type cast, since this is a plain .jsx file
      expect(result).toContain("const leaders = (await cimisyReader.collections.leadership.all()).map((entry) => entry.values);");
      expect(result).not.toContain(" as {");
      expect(result).toContain(
        "return <div>{leaders.map((member) => <Card key={member.name} name={member.name} title={member.title} />)}</div>;",
      );
      expect(result).toContain("export async function LeadershipGrid()");
      expect(result).toContain('import { createReader } from "cimisy/next";');
    });

    it("drops just the specifier (not the whole import) when other bindings share the statement", async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(path.join(root, "data", "shared.js"), `export const leaders = [{ name: "A" }];\nexport const other = 1;\n`);
      const componentFile = path.join(root, "Grid.jsx");
      const sourceText = `import { other, leaders } from "./data/shared";
export function Grid() {
  return <div>{leaders.map(l => <p key={l.name}>{l.name}</p>)}{other}</div>;
}
`;
      const { repeatingContent } = await findRepeatingContent(sourceText, componentFile);
      const candidate = repeatingContent[0]!;
      const result = rewriteArraySource({
        sourceText,
        filePath: componentFile,
        configFilePath: path.join(root, "cimisy.config.ts"),
        variableName: candidate.variableName,
        collectionName: "leadership",
        fields: inferSchema(candidate.items).fields,
        mapCallStart: candidate.mapCallStart,
      });
      assertNoSyntaxErrors(result);
      // `other` is still imported from the data module — only `leaders` was removed
      expect(result).toMatch(/import \{ ?other ?\} from "\.\/data\/shared"/);
      expect(result).toContain("{other}");
    });
  });
});

describe("rewriteArraySource — refuses to guess", () => {
  it("throws rather than inserting a top-level await when the .map() call isn't inside any function", async () => {
    const sourceText = `
      const items = [{ title: "A" }];
      const mapped = items.map((i) => i.title);
    `;
    const { repeatingContent } = await findRepeatingContent(sourceText, "/app/data.ts");
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
