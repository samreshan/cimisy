import { createInMemoryRateLimiter, type RateLimiter } from "../security/rate-limit.js";
import type { StorageAdapter } from "../storage/types.js";
import type { CollectionDefinition } from "./collection.js";
import type { FieldDefinition } from "./fields/types.js";
import type { SingletonDefinition } from "./singleton.js";

export type Action = "read" | "write" | "publish" | "manageSchema" | "manageUsers";

export interface RoleRule {
  path: string;
  actions: Action[];
}

export interface RoleDefinition {
  /** true: writes land as direct commits to the default branch. false: writes go to a per-user draft branch + PR (see src/rbac). */
  directPublish: boolean;
  rules: RoleRule[];
}

/**
 * Used whenever a config doesn't specify `roles` — a working, least-
 * privilege RBAC setup out of the box. `admin` additionally manages the
 * user roster (see rbac/user-store.ts); `publisher` and `editor` differ
 * only in `directPublish` — both can write, but an editor's saves always
 * land on a draft branch + PR instead of the default branch.
 */
export const DEFAULT_ROLES: Record<string, RoleDefinition> = {
  admin: {
    directPublish: true,
    rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema", "manageUsers"] }],
  },
  publisher: { directPublish: true, rules: [{ path: "**", actions: ["read", "write", "publish"] }] },
  editor: { directPublish: false, rules: [{ path: "**", actions: ["read", "write"] }] },
  viewer: { directPublish: false, rules: [{ path: "**", actions: ["read"] }] },
};

/**
 * Only consulted once, to decide who bootstraps as cimisy's first admin
 * (see rbac/user-store.ts's ensureUserRecord) — day-to-day role
 * resolution comes from the persisted user roster, not from GitHub
 * collaborator permission. Kept as a config surface in case a project
 * wants to change what counts as "admin enough to bootstrap".
 */
export const DEFAULT_ROLE_MAPPING: Record<string, string> = {
  admin: "admin",
  maintain: "admin",
  write: "editor",
  triage: "viewer",
  read: "viewer",
};

export interface CimisyConfig {
  source: StorageAdapter;
  collections: Record<string, CollectionDefinition<Record<string, FieldDefinition>>>;
  singletons?: Record<string, SingletonDefinition<Record<string, FieldDefinition>>>;
  /** Defaults to DEFAULT_ROLES if omitted. */
  roles?: Record<string, RoleDefinition>;
  /**
   * Maps a GitHub collaborator permission level (admin/maintain/write/
   * triage/read) to a role name above — used only to decide who's
   * "admin enough" to bootstrap as cimisy's first admin on an empty user
   * roster (see rbac/user-store.ts). Not consulted for any other user;
   * everyone else's role comes from the roster, assigned by an existing
   * admin. Defaults to DEFAULT_ROLE_MAPPING if omitted.
   */
  roleMapping?: Record<string, string>;
  /**
   * Rate-limits admin API writes (keyed by identity) and the OAuth
   * callback (keyed by IP) — one limiter, two differently-prefixed key
   * namespaces, rather than two separately-tunable limiters, to keep this
   * config surface small. Defaults to an in-memory limiter (see
   * security/rate-limit.ts) — fine for local dev and small
   * single-instance deployments, but NOT reliable across multiple
   * serverless function instances. Production deployments on
   * serverless/multi-instance infra should pass their own RateLimiter
   * backed by shared storage (Redis, Vercel KV, etc.).
   */
  rateLimiter?: RateLimiter;
}

const DEFAULT_RATE_LIMIT = { limit: 30, windowMs: 10_000 }; // 30 requests / 10s per key

export function config(options: CimisyConfig): CimisyConfig {
  const names = Object.keys(options.collections);
  const duplicatePaths = new Map<string, string>();
  for (const name of names) {
    const path = options.collections[name]!.path;
    const existing = duplicatePaths.get(path);
    if (existing) {
      throw new Error(`Collections "${existing}" and "${name}" both use path "${path}".`);
    }
    duplicatePaths.set(path, name);
  }
  return {
    ...options,
    roles: options.roles ?? DEFAULT_ROLES,
    roleMapping: options.roleMapping ?? DEFAULT_ROLE_MAPPING,
    rateLimiter: options.rateLimiter ?? createInMemoryRateLimiter(DEFAULT_RATE_LIMIT),
  };
}
