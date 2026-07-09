import { describe, expect, it } from "vitest";
import { UnsafePathError } from "../errors.js";
import { assertSafeSlug, entryPathForSlug, resolveCollectionShape, slugify } from "../slug.js";

describe("assertSafeSlug", () => {
  it("accepts simple lowercase-hyphen slugs", () => {
    expect(() => assertSafeSlug("hello-world")).not.toThrow();
    expect(() => assertSafeSlug("post-1")).not.toThrow();
  });

  const payloads = [
    "../../../etc/passwd",
    "..%2F..%2Fetc%2Fpasswd",
    "/etc/passwd",
    "..\\..\\windows\\system32",
    "a/b",
    "a\0b",
    "UPPERCASE",
    "trailing-",
    "-leading",
    "",
    "a".repeat(201),
  ];

  it.each(payloads)("rejects unsafe slug: %j", (payload) => {
    expect(() => assertSafeSlug(payload)).toThrow(UnsafePathError);
  });

  it("rejects consecutive hyphens (not a valid single-segment slug)", () => {
    expect(() => assertSafeSlug("double--hyphen")).toThrow(UnsafePathError);
  });
});

describe("slugify", () => {
  it("normalizes titles into safe slugs", () => {
    expect(slugify("Hello, Cimisy!")).toBe("hello-cimisy");
    expect(slugify("Café & Résumé")).toBe("cafe-resume");
    expect(slugify("  spaced   out  ")).toBe("spaced-out");
  });
});

describe("resolveCollectionShape", () => {
  it("parses a valid single-segment glob", () => {
    expect(resolveCollectionShape("content/posts/*.mdx")).toEqual({
      directory: "content/posts",
      extension: ".mdx",
    });
  });

  it("rejects globs with traversal", () => {
    expect(() => resolveCollectionShape("content/../secrets/*.mdx")).toThrow(UnsafePathError);
  });

  it("rejects malformed globs", () => {
    expect(() => resolveCollectionShape("content/posts/**/*.mdx")).toThrow(UnsafePathError);
    expect(() => resolveCollectionShape("content/posts")).toThrow(UnsafePathError);
  });
});

describe("entryPathForSlug", () => {
  it("builds the expected path for a safe slug", () => {
    expect(entryPathForSlug("content/posts/*.mdx", "hello-world")).toBe("content/posts/hello-world.mdx");
  });

  it("rejects an unsafe slug even with a valid collection glob", () => {
    expect(() => entryPathForSlug("content/posts/*.mdx", "../../etc/passwd")).toThrow(UnsafePathError);
  });
});
