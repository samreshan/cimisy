import { describe, expect, it } from "vitest";
import type { NormalizedSingleton } from "../../config/define-config.js";
import { blocks, fields } from "../../config/fields/index.js";
import { ValidationError } from "../../shared/errors.js";
import { parseSingleton, serializeSingleton } from "../singleton-codec.js";

const yamlDef: NormalizedSingleton = {
  key: "settings",
  label: "Settings",
  path: "content/settings.yaml",
  format: "yaml",
  schema: {
    siteName: fields.text({ label: "Site name" }),
    heroImage: fields.image({ label: "Hero", directory: "content/uploads" }),
  },
};

const mdxDef: NormalizedSingleton = {
  key: "about",
  label: "About",
  path: "content/about.mdx",
  format: "mdx",
  schema: {
    title: fields.text({ label: "Title" }),
    body: fields.blocks({ label: "Body", blocks: { paragraph: blocks.paragraph() } }),
  },
};

describe("singleton codec — YAML format", () => {
  it("round-trips values as a plain YAML mapping with no frontmatter fences", () => {
    const raw = serializeSingleton(yamlDef, { siteName: "Acme", heroImage: "content/uploads/x.png" });
    expect(raw).not.toContain("---");
    expect(parseSingleton(yamlDef, raw)).toEqual({ siteName: "Acme", heroImage: "content/uploads/x.png" });
  });

  it("fails closed on YAML that only produces warnings (e.g. unresolved !!js tags)", () => {
    expect(() => parseSingleton(yamlDef, 'siteName: !!js/function "function(){}"\nheroImage: null\n')).toThrow(
      ValidationError,
    );
  });

  it("fails closed on YAML parse errors and non-mapping documents", () => {
    expect(() => parseSingleton(yamlDef, "siteName: [unclosed")).toThrow(ValidationError);
    expect(() => parseSingleton(yamlDef, "- just\n- a\n- list\n")).toThrow(ValidationError);
    expect(() => parseSingleton(yamlDef, "just a scalar")).toThrow(ValidationError);
  });

  it("rejects a value that fails a field's own zod schema", () => {
    expect(() => parseSingleton(yamlDef, "siteName: Acme\nheroImage: ../../etc/passwd\n")).toThrow(ValidationError);
  });
});

describe("singleton codec — MDX format", () => {
  it("round-trips frontmatter + block body through the entry codec", () => {
    const values = {
      title: "About us",
      body: [{ type: "paragraph", id: "p1", props: { content: [{ type: "text", text: "Hello." }] } }],
    };
    const raw = serializeSingleton(mdxDef, values);
    expect(raw.startsWith("---\n")).toBe(true);
    const parsed = parseSingleton(mdxDef, raw);
    expect(parsed.title).toBe("About us");
    expect(parsed.body).toHaveLength(1);
  });
});
