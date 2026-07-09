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
