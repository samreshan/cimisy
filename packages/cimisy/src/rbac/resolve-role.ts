import "server-only";
import { DEFAULT_ROLE_MAPPING, DEFAULT_ROLES, type RoleDefinition } from "../config/define-config.js";
import { ForbiddenError } from "../shared/errors.js";
import type { GithubIntegratedSource } from "../shared/github-source-shape.js";

const LOCAL_ROLE: RoleDefinition = {
  directPublish: true,
  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema"] }],
};

export interface ResolvedRole {
  roleName: string;
  role: RoleDefinition;
}

/**
 * Collaborator-permission lookups are cached briefly per adapter instance
 * — long enough to avoid an extra GitHub API round trip on every single
 * admin request, short enough that a revoked collaborator loses access
 * promptly rather than only after their session cookie eventually expires
 * (see the plan's RBAC notes: re-validate periodically, not just at login).
 * Keyed by username alone: one cimisy deployment always targets exactly
 * one repo (bound in cimisy.config.ts), so there's nothing else to scope by.
 */
const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map<string, { permission: string | null; expiresAt: number }>();

async function getCachedCollaboratorPermission(
  source: GithubIntegratedSource,
  username: string,
): Promise<string | null> {
  const cached = permissionCache.get(username);
  if (cached && cached.expiresAt > Date.now()) return cached.permission;
  const permission = await source.getCollaboratorPermission(username);
  permissionCache.set(username, { permission, expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS });
  return permission;
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
 */
export async function resolveRole(
  cimisyConfig: ResolveRoleConfig,
  source: GithubIntegratedSource | null,
  username: string,
): Promise<ResolvedRole> {
  if (!source) return { roleName: "local-admin", role: LOCAL_ROLE };

  const permission = await getCachedCollaboratorPermission(source, username);
  if (!permission) {
    throw new ForbiddenError(`"${username}" is not a collaborator on this repository.`);
  }

  const roleMapping = cimisyConfig.roleMapping ?? DEFAULT_ROLE_MAPPING;
  const roles = cimisyConfig.roles ?? DEFAULT_ROLES;
  const roleName = roleMapping[permission];
  const role = roleName ? roles[roleName] : undefined;
  if (!roleName || !role) {
    throw new ForbiddenError(
      `GitHub permission "${permission}" has no corresponding cimisy role (check roleMapping/roles in cimisy.config.ts).`,
    );
  }
  return { roleName, role };
}
