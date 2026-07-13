import { describe, expect, it } from "vitest";
import {
  assertSafeContentKey,
  draftBranchName,
  parseDraftBranchName,
  SINGLETON_DRAFT_SLUG,
} from "../branch-name.js";
import { UnsafePathError } from "../errors.js";

describe("draftBranchName", () => {
  it("builds the expected deterministic branch name from safe components", () => {
    expect(draftBranchName("alice", "posts", "hello-world")).toBe("cimisy/alice/posts/hello-world");
  });

  it("accepts single characters and long-but-valid components", () => {
    expect(() => draftBranchName("a", "b", "c")).not.toThrow();
    expect(() => draftBranchName("a".repeat(63), "posts", "slug")).not.toThrow();
  });

  it("accepts a mixed-case username (real GitHub logins aren't lowercase-only)", () => {
    expect(() => draftBranchName("JohnDoe", "posts", "hello-world")).not.toThrow();
  });

  it("rejects a mixed-case or overlong slug even though usernames allow it — slug follows cimisy's own (stricter, lowercase-only) convention, not the ref-component pattern", () => {
    expect(() => draftBranchName("alice", "posts", "UPPERCASE")).toThrow(UnsafePathError);
    expect(() => draftBranchName("alice", "posts", "MixedCase")).toThrow(UnsafePathError);
    expect(() => draftBranchName("alice", "posts", "a".repeat(64))).not.toThrow(); // valid for assertSafeSlug (200-char cap)
    expect(() => draftBranchName("alice", "posts", "a".repeat(201))).toThrow(UnsafePathError); // over assertSafeSlug's cap
  });

  // Payloads unsafe for both the ref-component pattern (username/collectionName) and assertSafeSlug (slug).
  const unsafeEverywhere = [
    "../../../etc/passwd",
    "..",
    "a/b",
    "a\\b",
    "a\0b",
    "",
    "-leading-hyphen",
    "trailing-hyphen-",
    "with space",
    "with/slash",
    "..%2f..",
  ];

  it.each(unsafeEverywhere)("rejects an unsafe username: %j", (bad) => {
    expect(() => draftBranchName(bad, "posts", "slug")).toThrow(UnsafePathError);
  });

  it.each(unsafeEverywhere)("rejects an unsafe content key: %j", (bad) => {
    expect(() => draftBranchName("alice", bad, "slug")).toThrow(UnsafePathError);
  });

  it("accepts dotted content keys (page-nested content) and the singleton draft slug", () => {
    expect(draftBranchName("alice", "home.testimonials", "quote-one")).toBe(
      "cimisy/alice/home.testimonials/quote-one",
    );
    expect(draftBranchName("alice", "settings", SINGLETON_DRAFT_SLUG)).toBe("cimisy/alice/settings/singleton");
  });

  it.each([
    ".leading-dot",
    "trailing-dot.",
    "a..b", // empty segment
    "home.lock", // git rejects refs whose components end in .lock
    ".",
    "a." + "b".repeat(120), // over the content-key length cap
  ])("rejects a malformed dotted content key: %j", (bad) => {
    expect(() => draftBranchName("alice", bad, "slug")).toThrow(UnsafePathError);
  });

  it("still accepts a single-segment key named exactly 'lock' (only a *.lock suffix is unsafe)", () => {
    expect(() => draftBranchName("alice", "lock", "slug")).not.toThrow();
  });

  it.each(unsafeEverywhere)("rejects an unsafe slug: %j", (bad) => {
    expect(() => draftBranchName("alice", "posts", bad)).toThrow(UnsafePathError);
  });

  it("rejects a username over the ref-component length cap (63 chars)", () => {
    expect(() => draftBranchName("a".repeat(64), "posts", "slug")).toThrow(UnsafePathError);
  });
});

describe("assertSafeContentKey", () => {
  it("accepts top-level and dotted keys", () => {
    expect(() => assertSafeContentKey("posts")).not.toThrow();
    expect(() => assertSafeContentKey("home.hero")).not.toThrow();
    expect(() => assertSafeContentKey("home.hero-banner")).not.toThrow();
  });

  it("stays a superset of the original flat collection-name grammar (mixed case parses, for old branches)", () => {
    expect(() => assertSafeContentKey("blogPosts")).not.toThrow();
  });

  it.each(["", "..", "a..b", ".a", "a.", "home.lock", "a/b", "a\\b", "a\0b", "with space"])(
    "rejects: %j",
    (bad) => {
      expect(() => assertSafeContentKey(bad)).toThrow(UnsafePathError);
    },
  );
});

describe("parseDraftBranchName", () => {
  it("is the exact inverse of draftBranchName for well-formed branches", () => {
    const branch = draftBranchName("alice", "posts", "hello-world");
    expect(parseDraftBranchName(branch)).toEqual({ username: "alice", contentKey: "posts", slug: "hello-world" });
  });

  it("round-trips dotted content keys and singleton drafts", () => {
    expect(parseDraftBranchName("cimisy/alice/home.testimonials/quote-one")).toEqual({
      username: "alice",
      contentKey: "home.testimonials",
      slug: "quote-one",
    });
    expect(parseDraftBranchName("cimisy/alice/settings/singleton")).toEqual({
      username: "alice",
      contentKey: "settings",
      slug: SINGLETON_DRAFT_SLUG,
    });
  });

  it("still parses a legacy flat-collection branch", () => {
    expect(parseDraftBranchName("cimisy/JohnDoe/posts/hello-world")).toEqual({
      username: "JohnDoe",
      contentKey: "posts",
      slug: "hello-world",
    });
  });

  it("preserves a mixed-case username", () => {
    const branch = draftBranchName("JohnDoe", "posts", "hello-world");
    expect(parseDraftBranchName(branch)).toEqual({ username: "JohnDoe", contentKey: "posts", slug: "hello-world" });
  });

  it.each([
    "not-a-cimisy-branch",
    "cimisy/only-two-parts",
    "cimisy/a/b/c/d",
    "other-prefix/alice/posts/hello",
    "cimisy//posts/hello", // empty username segment
    "cimisy/alice/posts/UPPERCASE", // invalid slug shape
    "cimisy/alice/posts/", // empty slug
    "",
    "cimisy/../../../etc/passwd/x",
  ])("returns null (not a throw) for a malformed or non-draft branch: %j", (bad) => {
    expect(parseDraftBranchName(bad)).toBeNull();
  });

  it("returns null rather than throwing, so callers can safely probe arbitrary client-supplied refs", () => {
    expect(() => parseDraftBranchName("../../etc/passwd")).not.toThrow();
  });
});
