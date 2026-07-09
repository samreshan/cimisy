import "server-only";
import type { NextRequest } from "next/server";
import type { Action, CimisyConfig } from "../config/define-config.js";
import { requirePermission } from "../rbac/require-permission.js";
import { resolveRole } from "../rbac/resolve-role.js";
import { isGithubSource } from "../shared/github-source-shape.js";
import type { ChangeAuthor } from "../storage/types.js";
import { SESSION_COOKIE_NAME, type SessionPayload, verifySessionToken } from "./session.js";

export const DEFAULT_REF = "main";

/**
 * The local adapter has no auth layer at all — every request acts as this
 * fixed identity. Safe because the local adapter itself refuses to run
 * under NODE_ENV=production (see storage/local.ts), so there is no
 * unauthenticated-write-in-prod path even though no session exists here.
 */
const LOCAL_AUTHOR: ChangeAuthor = { id: "local", name: "Local", email: "local@localhost" };

export interface Actor {
  author: ChangeAuthor;
  /** GitHub login (or "local" in local mode) — used to name draft branches. */
  login: string;
  roleName: string;
  directPublish: boolean;
  requirePermission: (action: Action, path: string) => void;
}

/**
 * Resolves identity (who is this) and role (what can they do) together,
 * since role resolution needs the identity's username. Returns null only
 * when there's no valid session at all (→ 401); an authenticated identity
 * with no permitted role throws ForbiddenError from resolveRole itself
 * (→ 403) rather than silently falling back to "no access" here — a
 * misconfigured roleMapping should be loud, not swallowed.
 *
 * Shared by route-handler.ts (the admin API) and draft-mode.ts (the
 * preview-enabling route) — both need the same identity/role resolution,
 * and duplicating it would risk the two drifting out of sync.
 */
export async function resolveActor(request: NextRequest, cimisyConfig: CimisyConfig): Promise<Actor | null> {
  const source = cimisyConfig.source;
  if (!isGithubSource(source)) {
    return {
      author: LOCAL_AUTHOR,
      login: "local",
      roleName: "local-admin",
      directPublish: true,
      requirePermission: () => {}, // local mode: no roles concept, nothing to check
    };
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session: SessionPayload | null = await verifySessionToken(token, source.sessionSecret);
  if (!session) return null;

  const { roleName, role } = await resolveRole(cimisyConfig, source, session.githubLogin);
  const author: ChangeAuthor = {
    id: session.githubUserId,
    name: session.name ?? session.githubLogin,
    email: session.email ?? `${session.githubUserId}+${session.githubLogin}@users.noreply.github.com`,
  };
  return {
    author,
    login: session.githubLogin,
    roleName,
    directPublish: role.directPublish,
    requirePermission: (action, path) => requirePermission(role, action, path),
  };
}
