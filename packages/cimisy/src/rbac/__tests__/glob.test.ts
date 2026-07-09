import { describe, expect, it } from "vitest";
import { matchPathGlob } from "../glob.js";

describe("matchPathGlob", () => {
  it("matches an exact literal path", () => {
    expect(matchPathGlob("content/settings/site.yaml", "content/settings/site.yaml")).toBe(true);
    expect(matchPathGlob("content/settings/site.yaml", "content/settings/other.yaml")).toBe(false);
  });

  it("'**' alone matches everything, including empty and deep paths", () => {
    expect(matchPathGlob("**", "content/blog/post.mdx")).toBe(true);
    expect(matchPathGlob("**", "a")).toBe(true);
  });

  it("'dir/**' matches the directory itself and anything under it", () => {
    expect(matchPathGlob("content/blog/**", "content/blog")).toBe(true);
    expect(matchPathGlob("content/blog/**", "content/blog/post.mdx")).toBe(true);
    expect(matchPathGlob("content/blog/**", "content/blog/2024/post.mdx")).toBe(true);
  });

  it("'dir/**' does not match a sibling directory (no prefix-string false positives)", () => {
    expect(matchPathGlob("content/blog/**", "content/blogging/post.mdx")).toBe(false);
    expect(matchPathGlob("content/blog/**", "content/other/post.mdx")).toBe(false);
  });

  it("'*' matches exactly one segment, not multiple", () => {
    expect(matchPathGlob("content/*/post.mdx", "content/blog/post.mdx")).toBe(true);
    expect(matchPathGlob("content/*/post.mdx", "content/blog/2024/post.mdx")).toBe(false);
  });

  it("a pattern with no wildcard requires an exact segment-count match", () => {
    expect(matchPathGlob("content/blog", "content/blog/post.mdx")).toBe(false);
    expect(matchPathGlob("content/blog", "content")).toBe(false);
  });
});
