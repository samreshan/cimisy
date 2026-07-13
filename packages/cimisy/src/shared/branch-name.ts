import { UnsafePathError } from "./errors.js";
import { assertSafeSlug } from "./slug.js";

// GitHub usernames legitimately allow mixed case (e.g. "JohnDoe"), unlike
// cimisy's own slug convention — this pattern is deliberately more
// permissive than assertSafeSlug for that reason. Still independently
// re-validated here rather than trusted from its origin, same
// defense-in-depth posture as shared/slug.ts for filesystem/API paths.
const SAFE_REF_COMPONENT = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const MAX_CONTENT_KEY_LENGTH = 100;

/**
 * The slug literal reserved for singleton drafts — a singleton has no slug
 * of its own, but the draft-branch grammar needs exactly four segments, so
 * every singleton draft uses this constant as its fourth. config()'s key
 * validation makes collisions impossible in practice (a collection entry
 * could legitimately be slugged "singleton", but its branch also carries a
 * collection key, and keys are unique across collections ∪ singletons).
 */
export const SINGLETON_DRAFT_SLUG = "singleton";

function assertSafeRefComponent(value: string, label: string): void {
  if (!SAFE_REF_COMPONENT.test(value)) {
    throw new UnsafePathError(`${label} "${value}" is not safe to use in a git ref.`);
  }
}

/**
 * A content key is one or more dot-joined ref-safe segments — "posts" for
 * a top-level collection/singleton, "home.hero" for page-nested content.
 * Validated segment-wise so `..`, leading/trailing dots, and empty
 * segments are impossible by construction; a trailing ".lock" (git
 * refuses refs whose components end in ".lock") is rejected here as well
 * as at config() time. Each segment reuses SAFE_REF_COMPONENT, which
 * makes this grammar a strict superset of the v2 collection-name rule —
 * pre-v3 draft branches keep parsing.
 */
export function assertSafeContentKey(key: string): asserts key is string {
  if (key.length === 0 || key.length > MAX_CONTENT_KEY_LENGTH) {
    throw new UnsafePathError(`Content key must be 1-${MAX_CONTENT_KEY_LENGTH} characters: "${key}"`);
  }
  const segments = key.split(".");
  for (const segment of segments) {
    assertSafeRefComponent(segment, "Content key segment");
  }
  if (segments.length > 1 && segments[segments.length - 1] === "lock") {
    throw new UnsafePathError(`Content key "${key}" must not end in ".lock" — git rejects such ref components.`);
  }
}

/**
 * Deterministic per-user, per-content draft branch name. Determinism
 * (rather than a random/generated branch id) is what lets repeated saves
 * land on the same branch — and by extension the same open PR — without
 * cimisy having to persist any draft-to-branch mapping itself.
 *
 * `slug` is validated via assertSafeSlug (the same lowercase-only
 * convention enforced everywhere a slug becomes a file/API path), not the
 * looser SAFE_REF_COMPONENT pattern used for username/contentKey — this
 * is the component most directly attacker-influenced, and it should
 * never be *more* permissive here than it is anywhere else it's checked.
 * Singleton drafts pass SINGLETON_DRAFT_SLUG (which is itself slug-safe).
 */
export function draftBranchName(username: string, contentKey: string, slug: string): string {
  assertSafeRefComponent(username, "Username");
  assertSafeContentKey(contentKey);
  assertSafeSlug(slug);
  return `cimisy/${username}/${contentKey}/${slug}`;
}

/**
 * The inverse of draftBranchName — parses (and re-validates) a branch name
 * of unknown origin back into its parts, returning null rather than
 * throwing on anything that isn't a well-formed draft branch. Used
 * wherever a ref comes from the client or from listing PRs on the repo
 * (drafts discovery, media reads on a draft branch, previewing someone
 * else's draft) — a plain split("/") is lossless here because
 * SAFE_REF_COMPONENT forbids "/" in username and content-key segments, so
 * the branch always has exactly 4 segments.
 */
export function parseDraftBranchName(branch: string): { username: string; contentKey: string; slug: string } | null {
  const parts = branch.split("/");
  if (parts.length !== 4 || parts[0] !== "cimisy") return null;
  const [, username, contentKey, slug] = parts as [string, string, string, string];
  try {
    assertSafeRefComponent(username, "Username");
    assertSafeContentKey(contentKey);
    assertSafeSlug(slug);
  } catch {
    return null;
  }
  return { username, contentKey, slug };
}
