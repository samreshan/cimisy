import "server-only";
import { DEFAULT_ROLES, type RoleDefinition } from "../config/define-config.js";
import { ForbiddenError } from "../shared/errors.js";
import type { GithubIntegratedSource } from "../shared/github-source-shape.js";
import { readUserRoster } from "./user-store.js";

const LOCAL_ROLE: RoleDefinition = {
  directPublish: true,
  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema", "manageUsers"] }],
};

export interface ResolvedRole {
  roleName: string;
  role: RoleDefinition;
}

export interface ResolveRoleConfig {
  roles?: Record<string, RoleDefinition>;
  roleMapping?: Record<string, string>;
}

/**
 * Local mode has no auth/roles concept at all — every request is
 * implicitly a full-access "local admin", the same trust model as M1/M2's
 * LOCAL_AUTHOR, and safe for the same reason: the local adapter refuses to
 * run under NODE_ENV=production.
 *
 * GitHub mode resolves role from the persisted user roster (rbac/
 * user-store.ts), keyed by the stable GitHub user id — not from live
 * GitHub collaborator permission (that's only ever consulted once, to
 * decide who bootstraps as the first admin on an empty roster; see
 * user-store.ts's ensureUserRecord). Returns null — not a thrown error —
 * when the signed-in user has no assigned role yet: that's the ordinary,
 * expected state for anyone who's signed in but hasn't been granted
 * access, and callers decide how to handle it (next/actor.ts throws for
 * every write/read-gated caller; the /auth/me route surfaces it as a
 * "pending" state instead of crashing). A role NAME that doesn't resolve
 * to a definition in cimisy.config.ts's `roles` is a different case — a
 * real misconfiguration — and still throws loudly rather than being
 * swallowed.
 */
export async function resolveRole(
  cimisyConfig: ResolveRoleConfig,
  source: GithubIntegratedSource | null,
  username: string,
  githubUserId: string,
): Promise<ResolvedRole | null> {
  if (!source) return { roleName: "local-admin", role: LOCAL_ROLE };

  const { users } = await readUserRoster(source);
  const record = users.find((u) => u.githubId === githubUserId);
  if (!record?.role) return null;

  const roles = cimisyConfig.roles ?? DEFAULT_ROLES;
  const role = roles[record.role];
  if (!role) {
    throw new ForbiddenError(
      `Role "${record.role}" assigned to "${username}" has no definition in cimisy.config.ts's roles.`,
    );
  }
  return { roleName: record.role, role };
}
