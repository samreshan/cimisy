import { UnsafePathError } from "./errors.js";
import { assertSafeSlug } from "./slug.js";

// GitHub usernames legitimately allow mixed case (e.g. "JohnDoe"), unlike
// cimisy's own slug convention — this pattern is deliberately more
// permissive than assertSafeSlug for that reason. Still independently
// re-validated here rather than trusted from its origin, same
// defense-in-depth posture as shared/slug.ts for filesystem/API paths.
const SAFE_REF_COMPONENT = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

function assertSafeRefComponent(value: string, label: string): void {
  if (!SAFE_REF_COMPONENT.test(value)) {
    throw new UnsafePathError(`${label} "${value}" is not safe to use in a git ref.`);
  }
}

/**
 * Deterministic per-user, per-entry draft branch name. Determinism (rather
 * than a random/generated branch id) is what lets repeated saves land on
 * the same branch — and by extension the same open PR — without cimisy
 * having to persist any draft-to-branch mapping itself.
 *
 * `slug` is validated via assertSafeSlug (the same lowercase-only
 * convention enforced everywhere a slug becomes a file/API path), not the
 * looser SAFE_REF_COMPONENT pattern used for username/collectionName —
 * this is the component most directly attacker-influenced, and it should
 * never be *more* permissive here than it is anywhere else it's checked.
 */
export function draftBranchName(username: string, collectionName: string, slug: string): string {
  assertSafeRefComponent(username, "Username");
  assertSafeRefComponent(collectionName, "Collection name");
  assertSafeSlug(slug);
  return `cimisy/${username}/${collectionName}/${slug}`;
}

/**
 * The inverse of draftBranchName — parses (and re-validates) a branch name
 * of unknown origin back into its parts, returning null rather than
 * throwing on anything that isn't a well-formed draft branch. Used
 * wherever a ref comes from the client or from listing PRs on the repo
 * (drafts discovery, media reads on a draft branch, previewing someone
 * else's draft) — a plain split("/") is lossless here because
 * SAFE_REF_COMPONENT forbids "/" in username/collectionName, so the
 * branch always has exactly 4 segments.
 */
export function parseDraftBranchName(branch: string): { username: string; collectionName: string; slug: string } | null {
  const parts = branch.split("/");
  if (parts.length !== 4 || parts[0] !== "cimisy") return null;
  const [, username, collectionName, slug] = parts as [string, string, string, string];
  try {
    assertSafeRefComponent(username, "Username");
    assertSafeRefComponent(collectionName, "Collection name");
    assertSafeSlug(slug);
  } catch {
    return null;
  }
  return { username, collectionName, slug };
}
