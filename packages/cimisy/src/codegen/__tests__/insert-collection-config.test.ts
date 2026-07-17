import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ensureNamedImport,
  insertCollectionIntoConfig,
  scaffoldConfigFile,
  toCollectionKey,
  type InsertCollectionOptions,
} from "../insert-collection-config.js";

function assertNoSyntaxErrors(sourceText: string): void {
  const { diagnostics } = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest },
    reportDiagnostics: true,
  });
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages).toEqual([]);
}

const sampleOptions: InsertCollectionOptions = {
  name: "news",
  label: "News",
  path: "news/*.mdx",
  proposal: {
    slugField: "slug",
    slugSourceField: "title",
    fields: [
      { name: "title", proposedKind: "text", sourceKind: "string", optional: false },
      { name: "date", proposedKind: "text", sourceKind: "string", optional: false },
      { name: "category", proposedKind: "text", sourceKind: "string", optional: false },
    ],
  },
};

describe("ensureNamedImport", () => {
  it("adds a missing name to an existing named import", () => {
    const result = ensureNamedImport('import { collection, config } from "cimisy/config";\n', "cimisy/config", ["fields"]);
    expect(result).toContain("import { collection, config, fields } from \"cimisy/config\";");
    assertNoSyntaxErrors(result);
  });

  it("is a no-op when all names are already imported", () => {
    const original = 'import { collection, config, fields } from "cimisy/config";\n';
    expect(ensureNamedImport(original, "cimisy/config", ["fields", "collection"])).toBe(original);
  });

  it("inserts a new import statement after the last existing import when the module isn't imported yet", () => {
    const original = 'import { config } from "cimisy/config";\nimport { localSource } from "cimisy/adapters/local";\n\nexport default config({});\n';
    const result = ensureNamedImport(original, "cimisy/adapters/github", ["githubSource"]);
    expect(result).toContain('import { githubSource } from "cimisy/adapters/github";');
    expect(result.indexOf('import { githubSource }')).toBeGreaterThan(result.indexOf('cimisy/adapters/local'));
    assertNoSyntaxErrors(result);
  });

  it("inserts at the top when there are no existing imports at all", () => {
    const result = ensureNamedImport("export default {};\n", "cimisy/config", ["config"]);
    expect(result.startsWith('import { config } from "cimisy/config";')).toBe(true);
    assertNoSyntaxErrors(result);
  });
});

describe("scaffoldConfigFile", () => {
  it("produces syntactically valid TS with an empty collections object", () => {
    const text = scaffoldConfigFile();
    assertNoSyntaxErrors(text);
    expect(text).toContain("collections: {}");
    expect(text).toContain('localSource({ rootDir: "./content" })');
  });
});

describe("insertCollectionIntoConfig", () => {
  it("inserts into an empty collections object and produces valid TS", () => {
    const before = scaffoldConfigFile();
    const after = insertCollectionIntoConfig(before, sampleOptions);
    assertNoSyntaxErrors(after);
    expect(after).toContain("news: collection({");
    expect(after).toContain('slugField: "slug"');
    expect(after).toContain('slug: fields.slug({ source: "title" })');
    expect(after).toContain('title: fields.text({ label: "Title" })');
    expect(after).toContain('date: fields.text({ label: "Date" })');
    // one level deeper than the `collections: {` line (2 spaces), matching the scaffold's own style
    expect(after).toContain("\n    news: collection({\n");
    // schema fields are one level deeper than `schema: {` (not two)
    expect(after).toContain('\n        slug: fields.slug({ source: "title" }),\n');
    expect(after).toContain('\n        title: fields.text({ label: "Title" }),\n');
  });

  it("inserts after an existing collection, adding a comma, and keeps the earlier one intact", () => {
    const before = [
      `import { collection, config, fields } from "cimisy/config";`,
      `import { localSource } from "cimisy/adapters/local";`,
      ``,
      `export default config({`,
      `  source: localSource({ rootDir: "./content" }),`,
      ``,
      `  collections: {`,
      `    posts: collection({`,
      `      label: "Posts",`,
      `      path: "posts/*.mdx",`,
      `      slugField: "slug",`,
      `      schema: { slug: fields.slug({ source: "title" }), title: fields.text({ label: "Title" }) },`,
      `    }),`,
      `  },`,
      `});`,
      ``,
    ].join("\n");

    const after = insertCollectionIntoConfig(before, sampleOptions);
    assertNoSyntaxErrors(after);
    expect(after).toContain("posts: collection({");
    expect(after).toContain("news: collection({");
    // the new property must match the existing sibling's indentation exactly, not the `collections: {` line's
    expect(after).toContain("\n    news: collection({\n");
    // the closing brace stays aligned with `collections: {`, one level shallower than the properties
    expect(after).toMatch(/\n {2}\},\n\}\);\n?$/);
    // exactly one comma between the two collection entries, no double-comma
    expect(after).not.toMatch(/,\s*,/);
  });

  it("adds the fields/collection named import when the file doesn't already import them", () => {
    const before = [
      `import { config } from "cimisy/config";`,
      `import { localSource } from "cimisy/adapters/local";`,
      ``,
      `export default config({`,
      `  source: localSource({ rootDir: "./content" }),`,
      `  collections: {},`,
      `});`,
      ``,
    ].join("\n");
    const after = insertCollectionIntoConfig(before, sampleOptions);
    assertNoSyntaxErrors(after);
    expect(after).toMatch(/import \{ config, collection, fields \} from "cimisy\/config";/);
  });

  it("throws a clear error on a name collision", () => {
    const before = insertCollectionIntoConfig(scaffoldConfigFile(), sampleOptions);
    expect(() => insertCollectionIntoConfig(before, sampleOptions)).toThrow(/already has a collection named "news"/);
  });

  it("throws a clear error when the file doesn't have the expected config({...}) shape", () => {
    expect(() => insertCollectionIntoConfig("export const notCimisy = 1;\n", sampleOptions)).toThrow(/Could not find/);
  });

  it("generates an array-of-text and image field correctly", () => {
    const options: InsertCollectionOptions = {
      name: "partners",
      label: "Partners",
      path: "partners/*.mdx",
      proposal: {
        slugField: "slug",
        slugSourceField: "name",
        fields: [
          { name: "name", proposedKind: "text", sourceKind: "string", optional: false },
          { name: "logo", proposedKind: "image", sourceKind: "string", optional: false },
          { name: "tags", proposedKind: "array-of-text", sourceKind: "array", optional: true },
        ],
      },
    };
    const after = insertCollectionIntoConfig(scaffoldConfigFile(), options);
    assertNoSyntaxErrors(after);
    expect(after).toContain('logo: fields.image({ label: "Logo", directory: "public/images/partners" })');
    expect(after).toContain('tags: fields.array(fields.text({ label: "Tags" }))');
  });
});

describe("toCollectionKey", () => {
  it("normalizes scanned variable names into valid config keys", () => {
    expect(toCollectionKey("posts")).toBe("posts");
    expect(toCollectionKey("POSTS")).toBe("posts");
    expect(toCollectionKey("teamMembers")).toBe("team-members");
    expect(toCollectionKey("BLOG_POSTS")).toBe("blog-posts");
    expect(toCollectionKey("APIRoutes")).toBe("api-routes");
    expect(toCollectionKey("faqItems2024")).toBe("faq-items2024");
    expect(toCollectionKey("_private$stuff")).toBe("private-stuff");
  });

  it("dodges reserved admin screen keys and never returns an empty key", () => {
    expect(toCollectionKey("team")).toBe("team-collection");
    expect(toCollectionKey("MEDIA")).toBe("media-collection");
    expect(toCollectionKey("$_")).toBe("imported");
  });
});
