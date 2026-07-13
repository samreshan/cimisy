import { createInMemoryRateLimiter, type RateLimiter } from "../security/rate-limit.js";
import type { StorageAdapter } from "../storage/types.js";
import { assertSafeRepoPath, resolveCollectionShape } from "../shared/slug.js";
import type { CollectionDefinition } from "./collection.js";
import type { FieldDefinition } from "./fields/types.js";
import type { PageDefinition } from "./page.js";
import type { SectionDefinition } from "./section.js";
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

/**
 * A collection with its key, path, and shape fully resolved — what every
 * internal consumer (routes, reader, manifest, media) works with instead
 * of the raw declarative maps. Top-level collections keep their config
 * key; page-nested ones get "<pageKey>.<sectionKey>".
 */
export interface NormalizedCollection {
  key: string;
  label: string;
  path: string;
  directory: string;
  extension: string;
  slugField: string;
  schema: Record<string, FieldDefinition>;
  previewPath?: string;
}

export interface NormalizedSingleton {
  key: string;
  label: string;
  /** The one fixed file this singleton lives in, e.g. "content/settings.yaml". */
  path: string;
  format: "yaml" | "mdx";
  schema: Record<string, FieldDefinition>;
  previewPath?: string;
}

export type ContentTreeNode =
  | { kind: "collection"; key: string; label: string }
  | { kind: "singleton"; key: string; label: string }
  | { kind: "page"; key: string; label: string; route?: string; children: ContentTreeNode[] };

export interface CimisyConfig {
  source: StorageAdapter;
  collections?: Record<string, CollectionDefinition<Record<string, FieldDefinition>>>;
  singletons?: Record<string, SingletonDefinition<Record<string, FieldDefinition>>>;
  pages?: Record<string, PageDefinition>;
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
  /**
   * Populated by config() — the flat, fully-resolved views every internal
   * consumer uses. Never read the raw collections/singletons/pages maps
   * inside cimisy itself.
   */
  readonly collectionsByKey?: Record<string, NormalizedCollection>;
  readonly singletonsByKey?: Record<string, NormalizedSingleton>;
  readonly contentTree?: ContentTreeNode[];
}

/** CimisyConfig after config() — the normalized views are guaranteed present. */
export interface ResolvedCimisyConfig extends CimisyConfig {
  readonly roles: Record<string, RoleDefinition>;
  readonly roleMapping: Record<string, string>;
  readonly rateLimiter: RateLimiter;
  readonly collectionsByKey: Record<string, NormalizedCollection>;
  readonly singletonsByKey: Record<string, NormalizedSingleton>;
  readonly contentTree: ContentTreeNode[];
}

const DEFAULT_RATE_LIMIT = { limit: 30, windowMs: 10_000 }; // 30 requests / 10s per key

/**
 * Content keys become admin URLs, API route segments, and draft-branch ref
 * components, so they use the same strict charset as slugs. Kept in sync
 * with shared/slug.ts's SLUG_PATTERN on purpose (not imported — that one
 * asserts, this one classifies).
 */
const KEY_SEGMENT_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_KEY_LENGTH = 100;

/**
 * Top-level keys the admin UI routes on before consulting the manifest —
 * a collection or singleton with one of these keys would be unreachable
 * (or shadow a built-in screen), so fail loudly at config time.
 */
const RESERVED_TOP_LEVEL_KEYS = new Set(["team", "drafts", "pages", "new"]);

function assertValidKeySegment(segment: string, context: string): void {
  if (!KEY_SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `${context}: key "${segment}" is not valid — only lowercase letters, digits, and single hyphens are allowed (keys become URLs and git branch components).`,
    );
  }
}

/** e.g. "content/pages/home" — same charset resolveCollectionShape allows for directories. */
const PAGE_PATH_PATTERN = /^[a-zA-Z0-9/_-]+$/;

function assertValidPagePath(path: string, pageKey: string): void {
  if (!PAGE_PATH_PATTERN.test(path) || path.includes("..") || path.startsWith("/") || path.endsWith("/")) {
    throw new Error(
      `Page "${pageKey}": path "${path}" is not valid — use a repo-relative directory like "content/pages/${pageKey}".`,
    );
  }
}

function deriveSingletonFormat(
  schema: Record<string, FieldDefinition>,
  explicit: "yaml" | "mdx" | undefined,
  context: string,
): "yaml" | "mdx" {
  const hasBodyField = Object.values(schema).some((field) => field.location === "body");
  if (explicit === "yaml" && hasBodyField) {
    throw new Error(
      `${context}: format "yaml" cannot store body fields (fields.blocks) — use format "mdx" or drop the body field.`,
    );
  }
  return explicit ?? (hasBodyField ? "mdx" : "yaml");
}

const FORMAT_EXTENSIONS: Record<"yaml" | "mdx", string[]> = {
  yaml: [".yaml", ".yml"],
  mdx: [".mdx"],
};

function extensionForFormat(format: "yaml" | "mdx"): string {
  return format === "yaml" ? ".yaml" : ".mdx";
}

interface NormalizationState {
  collectionsByKey: Record<string, NormalizedCollection>;
  singletonsByKey: Record<string, NormalizedSingleton>;
  pathOwners: Map<string, string>;
  keyOwners: Map<string, string>;
}

function claimKey(state: NormalizationState, key: string, context: string): void {
  const segments = key.split(".");
  for (const segment of segments) {
    assertValidKeySegment(segment, context);
  }
  // A trailing "lock" segment would make the draft-branch ref component end
  // in ".lock", which git refuses to create — reject it here, where the fix
  // (rename the key) is obvious, not at first draft save.
  if (segments.length > 1 && segments[segments.length - 1] === "lock") {
    throw new Error(`${context}: key "${key}" must not end in ".lock" (git rejects such branch names) — rename the "lock" section.`);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`${context}: key "${key}" is longer than ${MAX_KEY_LENGTH} characters.`);
  }
  if (segments.length === 1 && RESERVED_TOP_LEVEL_KEYS.has(key)) {
    throw new Error(`${context}: "${key}" is reserved for the admin UI — pick another key.`);
  }
  const existing = state.keyOwners.get(key);
  if (existing) {
    throw new Error(`Content key "${key}" is declared twice (${existing} and ${context}).`);
  }
  state.keyOwners.set(key, context);
}

function claimPath(state: NormalizationState, path: string, key: string): void {
  assertSafeRepoPath(path);
  const existing = state.pathOwners.get(path);
  if (existing) {
    throw new Error(`Content keys "${existing}" and "${key}" both use path "${path}".`);
  }
  state.pathOwners.set(path, key);
}

function normalizeCollection(
  state: NormalizationState,
  key: string,
  def: CollectionDefinition<Record<string, FieldDefinition>>,
  context: string,
  derivedPathBase?: string,
): NormalizedCollection {
  claimKey(state, key, context);
  let path = def.path;
  let directory = def.directory;
  let extension = def.extension;
  if (path === undefined) {
    if (derivedPathBase === undefined) {
      throw new Error(`${context}: top-level collections must declare a path (e.g. "content/${key}/*.mdx").`);
    }
    const sectionKey = key.split(".").pop()!;
    path = `${derivedPathBase}/${sectionKey}/*.mdx`;
    ({ directory, extension } = resolveCollectionShape(path));
  } else if (directory === undefined || extension === undefined) {
    ({ directory, extension } = resolveCollectionShape(path));
  }
  claimPath(state, path, key);
  const normalized: NormalizedCollection = {
    key,
    label: def.label,
    path,
    directory: directory!,
    extension: extension!,
    slugField: def.slugField,
    schema: def.schema,
    previewPath: def.previewPath,
  };
  state.collectionsByKey[key] = normalized;
  return normalized;
}

function normalizeSingleton(
  state: NormalizationState,
  key: string,
  def: SingletonDefinition<Record<string, FieldDefinition>>,
  context: string,
): NormalizedSingleton {
  claimKey(state, key, context);
  const format = deriveSingletonFormat(def.schema, def.format, context);
  const extension = FORMAT_EXTENSIONS[format].find((ext) => def.path.endsWith(ext));
  if (!extension) {
    throw new Error(
      `${context}: path "${def.path}" doesn't match its ${format} format — expected a ${FORMAT_EXTENSIONS[format].join("/")} file.`,
    );
  }
  claimPath(state, def.path, key);
  const normalized: NormalizedSingleton = {
    key,
    label: def.label,
    path: def.path,
    format,
    schema: def.schema,
    previewPath: def.previewPath,
  };
  state.singletonsByKey[key] = normalized;
  return normalized;
}

function normalizeSection(
  state: NormalizationState,
  key: string,
  def: SectionDefinition<Record<string, FieldDefinition>>,
  context: string,
  pagePath: string,
  pageRoute: string | undefined,
): NormalizedSingleton {
  claimKey(state, key, context);
  const format = deriveSingletonFormat(def.schema, def.format, context);
  const sectionKey = key.split(".").pop()!;
  const path = `${pagePath}/${sectionKey}${extensionForFormat(format)}`;
  claimPath(state, path, key);
  const normalized: NormalizedSingleton = {
    key,
    label: def.label,
    path,
    format,
    schema: def.schema,
    // A section has no page of its own — previewing it means previewing
    // the page it renders on, so it inherits the page's route.
    previewPath: pageRoute,
  };
  state.singletonsByKey[key] = normalized;
  return normalized;
}

export function config(options: CimisyConfig): ResolvedCimisyConfig {
  const state: NormalizationState = {
    collectionsByKey: {},
    singletonsByKey: {},
    pathOwners: new Map(),
    keyOwners: new Map(),
  };
  const contentTree: ContentTreeNode[] = [];

  for (const [key, def] of Object.entries(options.collections ?? {})) {
    const normalized = normalizeCollection(state, key, def, `Collection "${key}"`);
    contentTree.push({ kind: "collection", key, label: normalized.label });
  }
  for (const [key, def] of Object.entries(options.singletons ?? {})) {
    const normalized = normalizeSingleton(state, key, def, `Singleton "${key}"`);
    contentTree.push({ kind: "singleton", key, label: normalized.label });
  }
  for (const [pageKey, pageDef] of Object.entries(options.pages ?? {})) {
    // Pages share the key namespace with collections/singletons — a page
    // and a collection both named "home" would be two different things at
    // the same address in the admin tree and the reader.
    claimKey(state, pageKey, `Page "${pageKey}"`);
    const pagePath = pageDef.path ?? `content/pages/${pageKey}`;
    assertValidPagePath(pagePath, pageKey);
    const children: ContentTreeNode[] = [];
    for (const [sectionKey, child] of Object.entries(pageDef.sections)) {
      const key = `${pageKey}.${sectionKey}`;
      if (child.type === "collection") {
        const normalized = normalizeCollection(
          state,
          key,
          child,
          `Page "${pageKey}" collection "${sectionKey}"`,
          pagePath,
        );
        children.push({ kind: "collection", key, label: normalized.label });
      } else {
        const normalized = normalizeSection(
          state,
          key,
          child,
          `Page "${pageKey}" section "${sectionKey}"`,
          pagePath,
          pageDef.route,
        );
        children.push({ kind: "singleton", key, label: normalized.label });
      }
    }
    contentTree.push({ kind: "page", key: pageKey, label: pageDef.label, route: pageDef.route, children });
  }

  return {
    ...options,
    roles: options.roles ?? DEFAULT_ROLES,
    roleMapping: options.roleMapping ?? DEFAULT_ROLE_MAPPING,
    rateLimiter: options.rateLimiter ?? createInMemoryRateLimiter(DEFAULT_RATE_LIMIT),
    collectionsByKey: state.collectionsByKey,
    singletonsByKey: state.singletonsByKey,
    contentTree,
  };
}
