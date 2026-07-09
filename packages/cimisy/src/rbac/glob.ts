/**
 * Minimal path-glob matcher for role rules — intentionally not a general
 * glob library (no dependency needed for this small, fully-specified
 * subset): "*" matches exactly one path segment, "**" matches zero or more
 * remaining segments. "dir/**" therefore matches both "dir" itself and
 * everything under it, which is the more intuitive reading for an access
 * rule ("this role can touch this directory") even though it's stricter
 * than some glob dialects that require at least one segment after "**".
 */
export function matchPathGlob(pattern: string, path: string): boolean {
  return matchSegments(pattern.split("/"), path.split("/"));
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...restPattern] = pattern;

  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(restPattern, path.slice(i))) return true;
    }
    return false;
  }

  if (path.length === 0) return false;
  const [pathHead, ...restPath] = path;
  if (head === "*" || head === pathHead) {
    return matchSegments(restPattern, restPath);
  }
  return false;
}
