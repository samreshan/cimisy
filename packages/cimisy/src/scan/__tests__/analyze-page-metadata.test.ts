import { describe, expect, it } from "vitest";
import { findPageMetadata } from "../analyze-page-metadata.js";

describe("findPageMetadata", () => {
  it("extracts title/description/canonical from a page's `export const metadata` (Janaki careers page shape)", () => {
    const source = `
      export const metadata = {
        title: 'Careers',
        description: 'Join a small, senior team in Lalitpur...',
        openGraph: { title: 'Careers — Janaki Technology', description: '...', url: '/careers' },
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

  it("does not extract openGraph.title/description separately — createMetadata() derives those FROM title/description", () => {
    const source = `
      export const metadata = {
        title: "Home",
        openGraph: { title: "Home | Acme", description: "A different og description" },
      };
    `;
    const result = findPageMetadata(source, "/app/page.tsx");
    expect(result.metadata).toHaveLength(1);
    expect(result.metadata[0]!.title).toBe("Home");
    expect(result.metadata[0]!.canonical).toBeUndefined();
  });
});
