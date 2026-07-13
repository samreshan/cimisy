import { describe, expect, it } from "vitest";
import { assertSafeContentKey, draftBranchName } from "../branch-name.js";
import { UnsafePathError } from "../errors.js";
import { assertSafeRepoPath, assertSafeSlug, entryPathForSlug } from "../slug.js";

/**
 * A permanent, shared payload corpus applied against every path-accepting
 * function in the codebase — not just the slug functions each have their
 * own tests already. The point of consolidating here is coverage that's
 * easy to extend in one place: any traversal technique found in the wild
 * (a new encoding trick, a new OS-specific separator quirk) gets added to
 * this one list and immediately re-verified against every function that
 * builds a path from user input.
 */
const TRAVERSAL_PAYLOADS = [
  "../../../etc/passwd",
  "..",
  "../",
  "..\\..\\windows\\system32",
  "..\\",
  "/etc/passwd",
  "/",
  "\\\\server\\share\\file",
  "C:\\Windows\\System32",
  "a/../../b",
  "a/b/../../../c",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "%2E%2E%2F",
  "..%2f..%2f..%2fetc%2fpasswd",
  "..%c0%af..%c0%afetc%c0%afpasswd", // overlong UTF-8 encoding of "/"
  "%252e%252e%252f", // double-encoded ../
  "....//....//etc/passwd", // strip-one-pass-through trick
  "...",
  "....",
  "a\0b",
  "a\0.mdx",
  "\0",
  "a/b",
  "a\\b",
  "",
  " ",
  "\t",
  "\n",
  " leading-space",
  "trailing-space ",
  "-leading-hyphen",
  "trailing-hyphen-",
  "UPPERCASE",
  "MixedCase",
  "has space",
  "has\ttab",
  "has\nnewline",
  "semi;colon",
  "amp&ersand",
  "quote'here",
  "double\"quote",
  "dollar$sign",
  "back`tick",
  "pipe|char",
  "a".repeat(10_000), // oversized input
];

describe("path-traversal fuzz sweep", () => {
  describe("assertSafeSlug", () => {
    it.each(TRAVERSAL_PAYLOADS)("rejects: %j", (payload) => {
      expect(() => assertSafeSlug(payload)).toThrow(UnsafePathError);
    });
  });

  describe("assertSafeRepoPath", () => {
    // assertSafeRepoPath deliberately allows normal multi-segment paths
    // (it's used for directory prefixes too), so only the genuinely
    // dangerous subset of the corpus applies here — payloads containing
    // "..", a leading "/", a backslash, or a null byte.
    const repoPathPayloads = TRAVERSAL_PAYLOADS.filter(
      (p) => p.includes("..") || p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.length > 1000,
    );
    it.each(repoPathPayloads)("rejects: %j", (payload) => {
      expect(() => assertSafeRepoPath(payload)).toThrow(UnsafePathError);
    });
  });

  describe("entryPathForSlug", () => {
    it.each(TRAVERSAL_PAYLOADS)("rejects unsafe slug %j regardless of a valid collection glob", (payload) => {
      expect(() => entryPathForSlug("content/posts/*.mdx", payload)).toThrow(UnsafePathError);
    });

    it.each(TRAVERSAL_PAYLOADS.filter((p) => p.includes("..")))(
      "rejects a malicious collection glob itself: %j",
      (payload) => {
        expect(() => entryPathForSlug(`content/${payload}/*.mdx`, "safe-slug")).toThrow(UnsafePathError);
      },
    );
  });

  describe("draftBranchName", () => {
    it.each(TRAVERSAL_PAYLOADS)("rejects unsafe slug %j in branch-name construction", (payload) => {
      expect(() => draftBranchName("alice", "posts", payload)).toThrow(UnsafePathError);
    });

    // Mixed case is legitimately allowed at the branch-grammar layer (the
    // v2 collection-name rule permitted it; old branches must keep
    // parsing) — config() is where the stricter lowercase key convention
    // is enforced. Everything else in the corpus must still throw.
    const contentKeyPayloads = TRAVERSAL_PAYLOADS.filter((p) => p !== "UPPERCASE" && p !== "MixedCase");

    it.each(contentKeyPayloads)("rejects unsafe content key %j in branch-name construction", (payload) => {
      expect(() => draftBranchName("alice", payload, "safe-slug")).toThrow(UnsafePathError);
    });
  });

  describe("assertSafeContentKey (dotted-key grammar)", () => {
    const contentKeyPayloads = TRAVERSAL_PAYLOADS.filter((p) => p !== "UPPERCASE" && p !== "MixedCase");
    // Dot-specific payloads: content keys are the one place cimisy allows
    // "." at all, so every dot-adjacent traversal/ref trick gets its own
    // sweep — plus the shared corpus (dots or not, none of it is a key).
    const DOTTED_PAYLOADS = [
      "..",
      "a..b",
      ".a",
      "a.",
      ".",
      "...",
      "a...b",
      "home.lock", // git rejects ref components ending in .lock
      "a.%2e.b",
      "a.․.b", // unicode "one dot leader" lookalike
      "a.．.b", // fullwidth full stop lookalike
      "a./b",
      "a.b/c",
      "a.b\\c",
      "a.b\0c",
      "a." + "b".repeat(200), // over the content-key length cap
    ];
    it.each([...contentKeyPayloads, ...DOTTED_PAYLOADS])("rejects: %j", (payload) => {
      expect(() => assertSafeContentKey(payload)).toThrow(UnsafePathError);
    });
  });

  it("every payload in the corpus is non-empty except the deliberate empty-string/whitespace cases (sanity check on the corpus itself)", () => {
    const meaningfullyEmpty = ["", " ", "\t", "\n"];
    const nonEmpty = TRAVERSAL_PAYLOADS.filter((p) => !meaningfullyEmpty.includes(p));
    expect(nonEmpty.every((p) => p.length > 0)).toBe(true);
  });
});
