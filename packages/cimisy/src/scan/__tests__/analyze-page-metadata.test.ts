import { describe, expect, it } from "vitest";
import { findPageMetadata } from "../analyze-page-metadata.js";

describe("findPageMetadata", () => {
  it("extracts title/description/canonical from a page's `export const metadata` (Janaki careers page shape)", () => {
    // og title/description mirror the top level — the only openGraph pair the
    // importer accepts since v2.3's hardening (createMetadata regenerates them).
    const source = `
      export const metadata = {
        title: 'Careers',
        description: 'Join a small, senior team in Lalitpur...',
        openGraph: { title: 'Careers', description: 'Join a small, senior team in Lalitpur...', url: '/careers' },
      };
    `;
    const result = findPageMetadata(source, "/app/careers/page.jsx");

    expect(result.unanalyzable).toEqual([]);
    expect(result.metadata).toHaveLength(1);
    const candidate = result.metadata[0]!;
    expect(candidate.title).toBe("Careers");
    expect(candidate.description).toBe("Join a small, senior team in Lalitpur...");
    expect(candidate.canonical).toBe("/careers");
    expect(source.slice(candidate.nodeStart, candidate.nodeEnd)).toContain("export const metadata = {");
  });

  it("works without an openGraph block (title/description only)", () => {
    const source = `export const metadata = { title: "About", description: "Who we are" };`;
    const result = findPageMetadata(source, "/app/about/page.tsx");
    expect(result.metadata).toEqual([
      { sourceFile: "/app/about/page.tsx", title: "About", description: "Who we are", canonical: undefined, nodeStart: 0, nodeEnd: source.length },
    ]);
  });

  it("ignores files with no `export const metadata`", () => {
    const source = `export default function Page() { return <div />; }`;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toEqual([]);
  });

  it("ignores a non-exported `const metadata`", () => {
    const source = `const metadata = { title: "Draft" };`;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toEqual([]);
  });

  it("reports a non-literal title as unanalyzable rather than dropping the whole page silently", () => {
    const source = `
      export const metadata = {
        title: getTitle(),
        description: "static",
      };
    `;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/"title" is not a plain string literal/);
  });

  it("reports a non-literal openGraph.url as unanalyzable", () => {
    const source = `
      export const metadata = {
        title: "Contact",
        openGraph: { url: buildUrl("/contact") },
      };
    `;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/"openGraph\.url" is not a plain string literal/);
  });

  it("reports an empty metadata object as unanalyzable (nothing to extract)", () => {
    const source = `export const metadata = {};`;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/no title, description, or openGraph\.url to extract/);
  });

  it("refuses divergent openGraph.title/description — createMetadata() derives those FROM title/description, so migrating would change the OG output (v2.3 hardening; pre-2.3 silently ignored them)", () => {
    const source = `
      export const metadata = {
        title: "Home",
        openGraph: { title: "Home | Acme", description: "A different og description" },
      };
    `;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toContain("openGraph.title");
  });
});

describe("findPageMetadata — v2.3 import-safety hardening", () => {
  it("refuses metadata with properties fields.seo() can't store, naming the first offender", () => {
    const result = findPageMetadata(
      `export const metadata = { title: "About", keywords: ["a", "b"] };`,
      "/app/about/page.tsx",
    );
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toContain(`"keywords"`);
    expect(result.unanalyzable[0]!.reason).toContain("silently drop");
  });

  it("refuses openGraph props beyond url/title/description (images would be dropped)", () => {
    const result = findPageMetadata(
      `export const metadata = { title: "About", openGraph: { url: "https://x.com/about", images: ["/og.png"] } };`,
      "/app/about/page.tsx",
    );
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable[0]!.reason).toContain("openGraph.images");
  });

  it("accepts openGraph title/description that duplicate the top level, refuses divergent ones", () => {
    const same = findPageMetadata(
      `export const metadata = { title: "About", openGraph: { title: "About", url: "https://x.com/about" } };`,
      "/app/about/page.tsx",
    );
    expect(same.metadata).toHaveLength(1);
    expect(same.metadata[0]!.canonical).toBe("https://x.com/about");

    const divergent = findPageMetadata(
      `export const metadata = { title: "About", openGraph: { title: "Different OG Title" } };`,
      "/app/about/page.tsx",
    );
    expect(divergent.metadata).toEqual([]);
    expect(divergent.unanalyzable[0]!.reason).toContain("openGraph.title");
  });

  it("reports a non-object-literal initializer instead of silently skipping it", () => {
    const result = findPageMetadata(`export const metadata = buildMetadata("about");`, "/app/about/page.tsx");
    expect(result.metadata).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toContain("not a plain object literal");
  });

  it("reports an existing generateMetadata export as already-dynamic", () => {
    for (const text of [
      `export async function generateMetadata() { return { title: "x" }; }`,
      `export const generateMetadata = async () => ({ title: "x" });`,
    ]) {
      const result = findPageMetadata(text, "/app/about/page.tsx");
      expect(result.unanalyzable).toHaveLength(1);
      expect(result.unanalyzable[0]!.reason).toContain("generateMetadata");
    }
  });

  it("unwraps `satisfies Metadata` instead of rejecting it", () => {
    const result = findPageMetadata(
      `import type { Metadata } from "next";\nexport const metadata = { title: "About" } satisfies Metadata;`,
      "/app/about/page.tsx",
    );
    expect(result.metadata).toHaveLength(1);
    expect(result.metadata[0]!.title).toBe("About");
  });

  it("refuses spread and shorthand properties (their values can't be read statically)", () => {
    const spread = findPageMetadata(`export const metadata = { ...base, title: "About" };`, "/app/page.tsx");
    expect(spread.metadata).toEqual([]);
    const shorthand = findPageMetadata(`const title = "About"; export const metadata = { title };`, "/app/page.tsx");
    expect(shorthand.metadata).toEqual([]);
  });
});
