import "server-only";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import type { GithubIntegratedSource } from "../shared/github-source-shape.js";
import { ValidationError } from "../shared/errors.js";
import type { ChangeAuthor } from "../storage/types.js";

export const USERS_FILE_PATH = ".cimisy/users.yaml";

export interface UserRecord {
  githubId: string;
  githubLogin: string;
  name: string | null;
  /** null = pending — signed in, but no cimisy role assigned yet (see ensureUserRecord below). */
  role: string | null;
  addedAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface UserRoster {
  users: UserRecord[];
  /** Opaque version token for optimistic-concurrency writes; null when the file doesn't exist yet. */
  version: string | null;
}

function parseRoster(raw: string): UserRecord[] {
  // Same fail-closed posture as content/codec.ts's frontmatter parsing:
  // any YAML warning is treated as a hard error, not tolerated — this file
  // gates write access, so anomalous content must be rejected outright.
  const doc = parseDocument(raw);
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    const issues = [...doc.errors, ...doc.warnings].map((e) => e.message).join("; ");
    throw new ValidationError(`"${USERS_FILE_PATH}" is not valid YAML: ${issues}`, null);
  }
  const parsed: unknown = doc.toJS();
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new ValidationError(`"${USERS_FILE_PATH}" must be a YAML list of user records.`, null);
  }
  return parsed as UserRecord[];
}

// Short TTL: unlike content, a role change should take effect on the
// next request or two, not linger for a full minute the way
// resolve-role.ts's collaborator-permission cache is allowed to.
const ROSTER_CACHE_TTL_MS = 5_000;
// Keyed by source instance (not a bare module-level singleton) so that
// distinct GithubIntegratedSource objects — different repos/configs, or
// just distinct instances across test runs — never share a cached roster.
const rosterCache = new WeakMap<GithubIntegratedSource, { roster: UserRoster; expiresAt: number }>();

export async function readUserRoster(
  source: GithubIntegratedSource,
  options: { bypassCache?: boolean } = {},
): Promise<UserRoster> {
  const cached = rosterCache.get(source);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) {
    return cached.roster;
  }
  const record = await source.read(USERS_FILE_PATH);
  const roster: UserRoster = record
    ? { users: parseRoster(record.content), version: record.version }
    : { users: [], version: null };
  rosterCache.set(source, { roster, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS });
  return roster;
}

export async function writeUserRoster(
  source: GithubIntegratedSource,
  users: UserRecord[],
  baseVersion: string | null,
  author: ChangeAuthor,
  message: string,
  ref: string,
): Promise<{ conflict?: { path: string; expected: string | null; actual: string } }> {
  const result = await source.commitChange({
    ref,
    baseVersion,
    message,
    author,
    writes: [{ path: USERS_FILE_PATH, content: stringifyYaml(users) }],
  });
  // Invalidate unconditionally, conflict or not — simplest correct
  // behavior is "the next read re-fetches", not tracking which write
  // actually landed.
  rosterCache.delete(source);
  return result.conflict ? { conflict: result.conflict } : {};
}

export interface EnsureUserRecordInput {
  githubId: string;
  githubLogin: string;
  name: string | null;
}

function systemAuthor(identity: EnsureUserRecordInput): ChangeAuthor {
  return {
    id: identity.githubId,
    name: identity.name ?? identity.githubLogin,
    email: `${identity.githubId}+${identity.githubLogin}@users.noreply.github.com`,
  };
}

/**
 * Called once per successful GitHub OAuth sign-in (see
 * next/auth-routes.ts's handleCallback) — this is the literal "GitHub
 * authentication creates a user" mechanic. A brand-new user is recorded
 * as pending (role: null) — UNLESS the roster is currently empty, in
 * which case this is the very first sign-in ever: if their live GitHub
 * collaborator permission maps to "admin" via `roleMapping` (defaults to
 * DEFAULT_ROLE_MAPPING), they become cimisy's first admin automatically,
 * the practical stand-in for "the repo owner is the admin". This
 * bootstrap check only ever fires once — as soon as the roster has at
 * least one entry, every subsequent new sign-in lands as pending no
 * matter their GitHub permission, and role changes become an explicit
 * admin action from then on (see the new /users routes in
 * next/route-handler.ts).
 *
 * A write conflict here (e.g. two people's very first sign-in racing on
 * an empty roster) is deliberately swallowed rather than retried or
 * surfaced: recording a login must never block the login itself, and an
 * unrecorded profile refresh or bootstrap attempt just resolves itself
 * on that person's next sign-in.
 */
export async function ensureUserRecord(
  source: GithubIntegratedSource,
  identity: EnsureUserRecordInput,
  ref: string,
  roleMapping: Record<string, string>,
): Promise<void> {
  const { users, version } = await readUserRoster(source, { bypassCache: true });
  const existing = users.find((u) => u.githubId === identity.githubId);
  const now = new Date().toISOString();

  if (existing) {
    if (existing.githubLogin === identity.githubLogin && existing.name === identity.name) return;
    const updated = users.map((u) =>
      u.githubId === identity.githubId
        ? { ...u, githubLogin: identity.githubLogin, name: identity.name, updatedAt: now }
        : u,
    );
    await writeUserRoster(
      source,
      updated,
      version,
      systemAuthor(identity),
      `cimisy: refresh profile for ${identity.githubLogin}`,
      ref,
    ).catch(() => {});
    return;
  }

  let role: string | null = null;
  if (users.length === 0) {
    const permission = await source.getCollaboratorPermission(identity.githubLogin);
    if (permission && roleMapping[permission] === "admin") role = "admin";
  }

  const record: UserRecord = {
    githubId: identity.githubId,
    githubLogin: identity.githubLogin,
    name: identity.name,
    role,
    addedAt: now,
    updatedAt: now,
    updatedBy: role ? identity.githubLogin : "system",
  };
  await writeUserRoster(
    source,
    [...users, record],
    version,
    systemAuthor(identity),
    role ? `cimisy: bootstrap ${identity.githubLogin} as admin` : `cimisy: register ${identity.githubLogin} (pending)`,
    ref,
  ).catch(() => {});
}
