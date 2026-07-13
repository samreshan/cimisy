import { describe, expect, it } from "vitest";
import type { NormalizedSingleton } from "../../define-config.js";
import { parseSingleton, serializeSingleton } from "../../../content/singleton-codec.js";
import { parseEntry, serializeEntry } from "../../../content/codec.js";
import { fields } from "../index.js";
import { seo } from "../seo.js";

describe("fields.seo() zod schema", () => {
  const field = seo();

  it("accepts partial values, an empty object, and treats an absent value as {}", () => {
    expect(field.zodSchema.safeParse({}).success).toBe(true);
    expect(field.zodSchema.safeParse({ title: "Hi" }).success).toBe(true);
    expect(field.zodSchema.safeParse(undefined).success).toBe(true);
    expect(field.zodSchema.parse(undefined)).toEqual({});
    expect(
      field.zodSchema.safeParse({
        title: "T",
        description: "D",
        canonical: "https://example.com/x",
        ogImage: "content/uploads/x.png",
        noindex: true,
      }).success,
    ).toBe(true);
  });

  it("accepts a site-relative canonical but rejects javascript:, http:, and protocol-relative ones", () => {
    expect(field.zodSchema.safeParse({ canonical: "/about" }).success).toBe(true);
    expect(field.zodSchema.safeParse({ canonical: "javascript:alert(1)" }).success).toBe(false);
    expect(field.zodSchema.safeParse({ canonical: "http://insecure.example" }).success).toBe(false);
    expect(field.zodSchema.safeParse({ canonical: "//evil.example" }).success).toBe(false);
  });

  it('rejects ".." in ogImage and unknown extra properties', () => {
    expect(field.zodSchema.safeParse({ ogImage: "../../etc/passwd" }).success).toBe(false);
    expect(field.zodSchema.safeParse({ tittle: "typo" }).success).toBe(false);
  });

  it("rejects an imageDirectory containing ..", () => {
    expect(() => seo({ imageDirectory: "../outside" })).toThrow();
  });
});

describe("fields.seo() round-trips through both codecs", () => {
  const seoValue = { title: "SEO Title", description: "Desc", canonical: "/x", ogImage: "content/uploads/a.png" };

  it("as nested frontmatter in an entry (MDX codec)", () => {
    const schema = {
      title: fields.text({ label: "Title" }),
      slug: fields.slug({ source: "title" }),
      seo: fields.seo(),
    };
    const raw = serializeEntry(schema, { title: "Post", slug: "post", seo: seoValue });
    expect(parseEntry(schema, "content/posts/post.mdx", raw).seo).toEqual(seoValue);
  });

  it("as a nested mapping in a YAML singleton", () => {
    const def: NormalizedSingleton = {
      key: "about",
      label: "About",
      path: "content/about.yaml",
      format: "yaml",
      schema: { heading: fields.text({ label: "Heading" }), seo: fields.seo() },
    };
    const raw = serializeSingleton(def, { heading: "About", seo: seoValue });
    expect(parseSingleton(def, raw).seo).toEqual(seoValue);
  });
});
