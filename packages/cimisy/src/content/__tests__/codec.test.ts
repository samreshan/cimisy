import { describe, expect, it } from "vitest";
import { blocks, fields } from "../../config/fields/index.js";
import { ValidationError } from "../../shared/errors.js";
import { parseEntry, serializeEntry } from "../codec.js";

const schema = {
  title: fields.text({ label: "Title", validation: { isRequired: true } }),
  slug: fields.slug({ source: "title" }),
  publishedAt: fields.date({ label: "Published at" }),
  body: fields.blocks({ label: "Body", blocks: { paragraph: blocks.paragraph() } }),
};

describe("serializeEntry / parseEntry round-trip", () => {
  it("round-trips scalar frontmatter fields and paragraph blocks", () => {
    const values = {
      title: "Hello World",
      slug: "hello-world",
      publishedAt: new Date("2026-01-15T00:00:00.000Z"),
      body: [
        { type: "paragraph", id: "1", props: { text: "First paragraph." } },
        { type: "paragraph", id: "2", props: { text: "Second paragraph." } },
      ],
    };
    const raw = serializeEntry(schema, values);
    expect(raw).toContain("title: Hello World");
    expect(raw).toContain("First paragraph.");

    const parsed = parseEntry(schema, "posts/hello-world.mdx", raw);
    expect(parsed.title).toBe("Hello World");
    expect(parsed.slug).toBe("hello-world");
    expect((parsed.publishedAt as Date).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(parsed.body).toEqual([
      { type: "paragraph", id: expect.any(String), props: { text: "First paragraph." } },
      { type: "paragraph", id: expect.any(String), props: { text: "Second paragraph." } },
    ]);
  });

  it("throws ValidationError when frontmatter is missing", () => {
    expect(() => parseEntry(schema, "posts/broken.mdx", "no frontmatter here")).toThrow(ValidationError);
  });

  it("throws ValidationError when a required field fails validation", () => {
    const raw = "---\ntitle: ''\nslug: x\npublishedAt: 2026-01-01\n---\n\n";
    expect(() => parseEntry(schema, "posts/broken.mdx", raw)).toThrow(ValidationError);
  });

  it("rejects a hand-edited YAML JS-tag injection attempt rather than tolerating it", () => {
    // yaml's Core schema has no `!!js/function` tag, so this can never
    // construct a real function — but `parse()` would only *warn* and
    // silently fall back to a best-effort value, which is too permissive
    // for a security-first parser. The codec uses parseDocument and treats
    // any warning as a hard failure, so this is rejected outright instead.
    const raw = "---\ntitle: !!js/function 'function(){return 1}'\nslug: safe-slug\npublishedAt: 2026-01-01\n---\n\n";
    expect(() => parseEntry(schema, "posts/malicious.mdx", raw)).toThrow(ValidationError);
  });
});
