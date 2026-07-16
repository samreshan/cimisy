import { describe, expect, it } from "vitest";
import { findPageMetadata } from "../../scan/analyze-page-metadata.js";
import { rewritePageMetadata } from "../rewrite-page-metadata.js";

function rewrite(sourceText: string, filePath: string, pageKey = "about", routePath = "/about"): string {
  const fresh = findPageMetadata(sourceText, filePath).metadata[0]!;
  return rewritePageMetadata({
    sourceText,
    filePath,
    configFilePath: "/project/cimisy.config.ts",
    pageKey,
    routePath,
    nodeStart: fresh.nodeStart,
    nodeEnd: fresh.nodeEnd,
  });
}

const TS_PAGE = `export const metadata = {
  title: "About",
  description: "Who we are",
};

export default function AboutPage() {
  return <main>about</main>;
}
`;

describe("rewritePageMetadata", () => {
  it("replaces the metadata statement with a generateMetadata() reading pages.<key>.seo (TS: with cast)", () => {
    const result = rewrite(TS_PAGE, "/project/src/app/about/page.tsx");
    expect(result).not.toContain("export const metadata");
    expect(result).toContain("export async function generateMetadata()");
    expect(result).toContain('(cimisyReader.pages.about.seo as import("cimisy/next").SingletonReader).get()');
    expect(result).toContain(`createMetadata({ seo: content?.seo, path: "/about" })`);
    expect(result).toContain(`as { seo?: import("cimisy/config").SeoValue } | undefined`);
    expect(result).toContain(`import { createReader } from "cimisy/next"`);
    expect(result).toContain(`import { createMetadata } from "cimisy/seo"`);
    expect(result).toContain(`import cimisyConfig from "../../../cimisy.config"`);
    // The page component itself is untouched.
    expect(result).toContain("export default function AboutPage()");
  });

  it("emits no TypeScript cast for a plain .jsx page", () => {
    const result = rewrite(TS_PAGE, "/project/src/app/about/page.jsx");
    expect(result).not.toContain(" as {");
    expect(result).toContain("export async function generateMetadata()");
  });

  it("quotes a kebab-case page key with bracket access", () => {
    const result = rewrite(TS_PAGE, "/project/src/app/open-roles/page.tsx", "open-roles", "/open-roles");
    expect(result).toContain(`(cimisyReader.pages["open-roles"].seo as import("cimisy/next").SingletonReader).get()`);
  });

  it("replaces a `satisfies Metadata` statement cleanly", () => {
    const source = `import type { Metadata } from "next";\nexport const metadata = { title: "About" } satisfies Metadata;\nexport default function P() { return null; }\n`;
    const result = rewrite(source, "/project/src/app/about/page.tsx");
    expect(result).not.toContain("export const metadata");
    expect(result).toContain("export async function generateMetadata()");
  });
});
