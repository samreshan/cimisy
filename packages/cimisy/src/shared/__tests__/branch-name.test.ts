import { describe, expect, it } from "vitest";
import { draftBranchName } from "../branch-name.js";
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

  it.each(unsafeEverywhere)("rejects an unsafe collection name: %j", (bad) => {
    expect(() => draftBranchName("alice", bad, "slug")).toThrow(UnsafePathError);
  });

  it.each(unsafeEverywhere)("rejects an unsafe slug: %j", (bad) => {
    expect(() => draftBranchName("alice", "posts", bad)).toThrow(UnsafePathError);
  });

  it("rejects a username over the ref-component length cap (63 chars)", () => {
    expect(() => draftBranchName("a".repeat(64), "posts", "slug")).toThrow(UnsafePathError);
  });
});
