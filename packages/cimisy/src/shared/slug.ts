import { UnsafePathError } from "./errors.js";

/**
 * Slugs are the only user-influenced input that ever becomes part of a
 * filesystem/git path. This charset is intentionally the strictest thing
 * that's still usable (lowercase letters, digits, single hyphens) rather
 * than "anything that isn't obviously `..`" — every path-traversal payload
 * class (`../`, absolute paths, null bytes, URL-encoded slashes, symlink
 * names) is excluded by construction, not by denylist pattern-matching.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;
// Unicode "Combining Diacritical Marks" block, left behind by NFKD
// normalization (e.g. "é" -> "e" + U+0301) — stripped before ASCII-folding.
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

export function assertSafeSlug(slug: string): asserts slug is string {
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) {
    throw new UnsafePathError(`Slug must be 1-${MAX_SLUG_LENGTH} characters: "${slug}"`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new UnsafePathError(
      `Slug "${slug}" is not safe — only lowercase letters, digits, and single hyphens are allowed.`,
    );
  }
}

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  assertSafeSlug(slug);
  return slug;
}

/**
 * Resolves a collection's glob (e.g. "content/posts/*.mdx") into a
 * directory + extension, then builds the entry path for a given slug.
 * Only single-star globs directly followed by an extension are supported
 * on purpose — anything more permissive widens the path-construction
 * surface without a real use case in v1.
 */
export function resolveCollectionShape(pathGlob: string): { directory: string; extension: string } {
  const match = /^(?<directory>[a-zA-Z0-9/_-]+)\/\*(?<extension>\.[a-z0-9]+)$/.exec(pathGlob);
  if (!match?.groups) {
    throw new UnsafePathError(
      `Collection path "${pathGlob}" must look like "some/directory/*.ext" (single segment glob).`,
    );
  }
  const directory = match.groups.directory;
  const extension = match.groups.extension;
  if (!directory || !extension) {
    throw new UnsafePathError(
      `Collection path "${pathGlob}" must look like "some/directory/*.ext" (single segment glob).`,
    );
  }
  if (directory.includes("..")) {
    throw new UnsafePathError(`Collection path "${pathGlob}" must not contain "..".`);
  }
  return { directory, extension };
}

export function entryPathForSlug(pathGlob: string, slug: string): string {
  assertSafeSlug(slug);
  const { directory, extension } = resolveCollectionShape(pathGlob);
  return `${directory}/${slug}${extension}`;
}

/**
 * Defense-in-depth for storage adapters: every adapter method that takes a
 * repo-relative path re-validates it independently rather than trusting
 * that the caller already built it from a safe slug (see local.ts's
 * resolveSafe for the filesystem equivalent). Directory prefixes (e.g.
 * "content/posts") are allowed here since list() takes one; only a single
 * strict slug charset is enforced in assertSafeSlug above.
 */
export function assertSafeRepoPath(path: string): asserts path is string {
  if (path.length === 0 || path.length > 1000) {
    throw new UnsafePathError(`Path must be 1-1000 characters: "${path}"`);
  }
  if (path.includes("..") || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new UnsafePathError(`Path "${path}" is not safe.`);
  }
}
