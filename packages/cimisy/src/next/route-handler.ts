import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import type { ResolvedCimisyConfig } from "../config/define-config.js";
import { deleteEntry, listEntries, readEntry, resolveEntrySlug, writeEntry } from "../content/collection-store.js";
import { ensureDraftBranchAndPr } from "../content/draft-workflow.js";
import { readSingleton, writeSingleton } from "../content/singleton-store.js";
import {
  assertConfiguredDirectory,
  assertPathUnderConfiguredDirectory,
  buildMediaPath,
  decodeUploadedImage,
  getConfiguredImageDirectories,
  sniffImageType,
} from "../content/media.js";
import { resolveRole } from "../rbac/resolve-role.js";
import { readUserRoster, writeUserRoster } from "../rbac/user-store.js";
import { assertSafeContentKey, draftBranchName, parseDraftBranchName, SINGLETON_DRAFT_SLUG } from "../shared/branch-name.js";
import { CimisyError, ConflictError, ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "../shared/errors.js";
import { isGithubSource } from "../shared/github-source-shape.js";
import { assertSafeRepoPath, assertSafeSlug, entryPathForSlug } from "../shared/slug.js";
import type { Actor } from "./actor.js";
import { DEFAULT_REF, resolveActor } from "./actor.js";
import { handleCallback, handleLogin, handleLogout } from "./auth-routes.js";
import { requireSameOrigin } from "./csrf.js";
import { handlePreviewDisable, handlePreviewEnable } from "./draft-mode.js";
import {
  deleteEntryBodySchema,
  setUserRoleBodySchema,
  uploadMediaBodySchema,
  writeEntryBodySchema,
  writeSingletonBodySchema,
} from "./request-schemas.js";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./session.js";

/** Not a real content path — RBAC's path-glob matching treats any string the same way, and a "**" rule already matches this, so no changes needed to rbac/glob.ts. */
const USERS_SENTINEL_PATH = "$users";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
  }
  if (err instanceof ConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof RateLimitedError) {
    const headers = err.retryAfterMs ? { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) } : undefined;
    return NextResponse.json({ error: err.message }, { status: 429, headers });
  }
  if (err instanceof CimisyError) return NextResponse.json({ error: err.message }, { status: 400 });
  // Deliberately no `err.message`/stack for unexpected errors — avoid leaking
  // internals (file paths, stack traces) to the client for anything we
  // didn't anticipate and classify above.
  console.error("[cimisy] unexpected error", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/**
 * Parses and validates the route in one step: an invalid slug is rejected
 * here, before any RBAC check or handler logic ever sees it, rather than
 * being passed through to whichever downstream call happens to validate
 * first. Also rejects unrecognized extra segments (e.g. a 4th segment
 * that isn't the dedicated /history route below) instead of silently
 * ignoring them.
 */
function parseRoute(routeParams: string[]): { contentKey: string; slug: string | null } | null {
  if (routeParams[0] !== "collections" || !routeParams[1]) return null;
  if (routeParams.length > 3) return null;
  assertSafeContentKey(routeParams[1]);
  const slug = routeParams[2] ?? null;
  if (slug !== null) assertSafeSlug(slug);
  return { contentKey: routeParams[1], slug };
}

function parseHistoryRoute(routeParams: string[]): { contentKey: string; slug: string } | null {
  if (routeParams[0] !== "collections" || !routeParams[1] || !routeParams[2] || routeParams[3] !== "history") return null;
  if (routeParams.length !== 4) return null;
  assertSafeContentKey(routeParams[1]);
  assertSafeSlug(routeParams[2]);
  return { contentKey: routeParams[1], slug: routeParams[2] };
}

/**
 * `/singletons/<key>` (read/write) and `/singletons/<key>/history` — a
 * singleton has no slug, so the route grammar stops at the key. Returns
 * null (→ 404) on a malformed key rather than throwing: unlike parseRoute
 * this runs in the dispatch table, outside any handler's try/catch.
 */
function parseSingletonRoute(routeParams: string[]): { contentKey: string; history: boolean } | null {
  if (routeParams[0] !== "singletons" || !routeParams[1]) return null;
  const history = routeParams.length === 3 && routeParams[2] === "history";
  if (routeParams.length !== 2 && !history) return null;
  try {
    assertSafeContentKey(routeParams[1]);
  } catch {
    return null;
  }
  return { contentKey: routeParams[1], history };
}

function parseDraftMergeRoute(routeParams: string[]): { id: string } | null {
  if (routeParams[0] !== "drafts" || !routeParams[1] || routeParams[2] !== "merge" || routeParams.length !== 3) return null;
  return { id: routeParams[1] };
}

/** Parses the request body against the given schema, turning malformed JSON or a mismatched shape into a clean ValidationError (400) instead of an unchecked cast or an uncaught SyntaxError (500). */
async function parseJsonBody<Schema extends z.ZodTypeAny>(request: NextRequest, schema: Schema): Promise<z.infer<Schema>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON.", null);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("Request body failed validation.", result.error.issues);
  }
  return result.data;
}

/**
 * Media reads (list/raw) accept an optional `?ref=` so the media browser
 * can show images that only exist on a draft branch (not deployed to the
 * default branch yet). Restricted to the default ref or a well-formed
 * `cimisy/*` draft branch — never an arbitrary client-supplied ref — since
 * this is handed straight to the storage adapter as a git ref to read
 * from.
 */
function resolveSafeRef(refParam: string | null): string {
  if (!refParam || refParam === DEFAULT_REF) return DEFAULT_REF;
  if (!parseDraftBranchName(refParam)) {
    throw new ValidationError(`"${refParam}" is not a valid ref.`, null);
  }
  return refParam;
}

/** Keyed by identity (not IP): the abuse case here is a compromised/buggy authenticated client hammering writes, not anonymous traffic — IP-keying would be trivially bypassed by anyone who can already authenticate. */
async function enforceWriteRateLimit(cimisyConfig: ResolvedCimisyConfig, actor: Actor): Promise<void> {
  const limiter = cimisyConfig.rateLimiter;
  if (!limiter) return;
  const result = await limiter.consume(`write:${actor.author.id}`);
  if (!result.allowed) {
    throw new RateLimitedError("Too many write requests — please slow down.", result.retryAfterMs);
  }
}

export function createCimisyHandler(cimisyConfig: ResolvedCimisyConfig) {
  async function handleAuth(request: NextRequest, action: string | undefined): Promise<NextResponse | null> {
    if (action === "me") {
      // Deliberately does its own session-verify + resolveRole instead of
      // calling resolveActor: resolveActor throws when there's no
      // assigned role, but "signed in, no role yet" is the ordinary
      // state for a brand-new user here — the client needs a pending
      // response, not a 500.
      if (!isGithubSource(cimisyConfig.source)) {
        const actor = await resolveActor(request, cimisyConfig);
        return NextResponse.json({ authenticated: true, user: actor!.author, role: actor!.roleName, pending: false });
      }
      const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
      if (!token) return NextResponse.json({ authenticated: false });
      const session = await verifySessionToken(token, cimisyConfig.source.sessionSecret);
      if (!session) return NextResponse.json({ authenticated: false });
      const resolved = await resolveRole(cimisyConfig, cimisyConfig.source, session.githubLogin, session.githubUserId);
      return NextResponse.json({
        authenticated: true,
        user: {
          id: session.githubUserId,
          name: session.name ?? session.githubLogin,
          email: session.email ?? `${session.githubUserId}+${session.githubLogin}@users.noreply.github.com`,
        },
        role: resolved?.roleName ?? null,
        pending: resolved === null,
      });
    }
    if (!isGithubSource(cimisyConfig.source)) {
      return NextResponse.json({ error: "Auth routes require the GitHub source." }, { status: 404 });
    }
    if (action === "login") return handleLogin(request, cimisyConfig.source, cimisyConfig.rateLimiter);
    if (action === "callback") {
      return handleCallback(request, cimisyConfig.source, cimisyConfig.rateLimiter, cimisyConfig.roleMapping);
    }
    if (action === "logout") {
      // POST-only so logout can't be triggered by a plain GET (e.g. an
      // <img> tag pointing at this URL from another site).
      if (request.method !== "POST") return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
      try {
        requireSameOrigin(request);
      } catch (err) {
        return errorResponse(err);
      }
      return handleLogout();
    }
    return null;
  }

  async function handleGet(request: NextRequest, params: { route: string[] }) {
    try {
      const parsed = parseRoute(params.route);
      if (!parsed) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const def = cimisyConfig.collectionsByKey[parsed.contentKey];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.contentKey}"` }, { status: 404 });

      if (parsed.slug === null) {
        actor.requirePermission("read", def.directory);
        const entries = await listEntries(cimisyConfig.source, def);
        return NextResponse.json({ entries });
      }
      actor.requirePermission("read", `${def.directory}/${parsed.slug}${def.extension}`);
      const entry = await readEntry(cimisyConfig.source, def, parsed.slug);
      if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ entry });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /** Surfaces git history for an entry (see storage/types.ts's optional getHistory) — the activity-log counterpart to the read/write API. Adapters without history support (the local adapter) report `supported: false` rather than erroring, so the UI can hide the section gracefully. */
  async function handleHistory(request: NextRequest, params: { route: string[] }) {
    try {
      const parsed = parseHistoryRoute(params.route);
      if (!parsed) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const def = cimisyConfig.collectionsByKey[parsed.contentKey];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.contentKey}"` }, { status: 404 });
      actor.requirePermission("read", `${def.directory}/${parsed.slug}${def.extension}`);

      if (!cimisyConfig.source.capabilities.history || !cimisyConfig.source.getHistory) {
        return NextResponse.json({ supported: false, history: [] });
      }
      const path = entryPathForSlug(def.path, parsed.slug);
      const history = await cimisyConfig.source.getHistory(path);
      return NextResponse.json({ supported: true, history });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Reads a singleton. A declared-but-never-saved singleton responds
   * `{ singleton: null }` rather than 404 on purpose: the singleton
   * exists (it's in config), it just has no file yet — the admin renders
   * an empty create form from this, and the reader's get() mirrors the
   * same null contract.
   */
  async function handleSingletonGet(request: NextRequest, contentKey: string): Promise<NextResponse> {
    try {
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const def = cimisyConfig.singletonsByKey[contentKey];
      if (!def) return NextResponse.json({ error: `Unknown singleton "${contentKey}"` }, { status: 404 });
      actor.requirePermission("read", def.path);
      const singleton = await readSingleton(cimisyConfig.source, def);
      return NextResponse.json({ singleton });
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function handleSingletonPut(request: NextRequest, contentKey: string): Promise<NextResponse> {
    try {
      requireSameOrigin(request);
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await enforceWriteRateLimit(cimisyConfig, actor);
      const def = cimisyConfig.singletonsByKey[contentKey];
      if (!def) return NextResponse.json({ error: `Unknown singleton "${contentKey}"` }, { status: 404 });

      const body = await parseJsonBody(request, writeSingletonBodySchema);
      actor.requirePermission("write", def.path);

      const { ref, publish } = await resolveWriteRef(actor, contentKey, SINGLETON_DRAFT_SLUG);
      const result = await writeSingleton(cimisyConfig.source, def, {
        values: body.values,
        baseVersion: body.baseVersion ?? null,
        author: actor.author,
        message: `Update ${contentKey}`,
        ref,
      });
      if (result.conflict) {
        return NextResponse.json({ error: "Version conflict", conflict: result.conflict }, { status: 409 });
      }
      return NextResponse.json({ version: result.version, publish });
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function handleSingletonHistory(request: NextRequest, contentKey: string): Promise<NextResponse> {
    try {
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const def = cimisyConfig.singletonsByKey[contentKey];
      if (!def) return NextResponse.json({ error: `Unknown singleton "${contentKey}"` }, { status: 404 });
      actor.requirePermission("read", def.path);

      if (!cimisyConfig.source.capabilities.history || !cimisyConfig.source.getHistory) {
        return NextResponse.json({ supported: false, history: [] });
      }
      const history = await cimisyConfig.source.getHistory(def.path);
      return NextResponse.json({ supported: true, history });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Direct-publish roles write straight to the default branch. Everyone
   * else drafts on a deterministic per-user/per-entry branch (created and
   * PR'd on first save, just committed to on every save after that) — this
   * is simultaneously the draft mechanism and the role-gated publish
   * mechanism described in the plan: branch = draft, merge = publish, and
   * cimisy never reimplements merge/approval — that's GitHub's own PR UI.
   */
  async function resolveWriteRef(
    actor: Actor,
    contentKey: string,
    slug: string,
  ): Promise<{ ref: string; publish: { status: "direct" } | { status: "draft"; branch: string; pullRequestUrl: string } }> {
    if (actor.directPublish) return { ref: DEFAULT_REF, publish: { status: "direct" } };
    const branch = draftBranchName(actor.login, contentKey, slug);
    const draft = await ensureDraftBranchAndPr(
      cimisyConfig.source,
      branch,
      DEFAULT_REF,
      `cimisy: ${contentKey}/${slug}`,
    );
    return { ref: branch, publish: { status: "draft", ...draft } };
  }

  async function handlePost(request: NextRequest, params: { route: string[] }) {
    try {
      requireSameOrigin(request);
      const parsed = parseRoute(params.route);
      if (!parsed) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await enforceWriteRateLimit(cimisyConfig, actor);
      const def = cimisyConfig.collectionsByKey[parsed.contentKey];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.contentKey}"` }, { status: 404 });

      const body = await parseJsonBody(request, writeEntryBodySchema);
      const slug = resolveEntrySlug(def, body.values, parsed.slug ?? undefined);
      actor.requirePermission("write", `${def.directory}/${slug}${def.extension}`);

      const { ref, publish } = await resolveWriteRef(actor, parsed.contentKey, slug);

      const { result, slug: writtenSlug } = await writeEntry(cimisyConfig.source, def, {
        slug,
        values: body.values,
        baseVersion: body.baseVersion ?? null,
        author: actor.author,
        message: parsed.slug ? `Update ${parsed.contentKey}/${slug}` : `Create ${parsed.contentKey}/${slug}`,
        ref,
      });
      if (result.conflict) {
        return NextResponse.json({ error: "Version conflict", conflict: result.conflict }, { status: 409 });
      }
      return NextResponse.json({ slug: writtenSlug, version: result.version, publish });
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function handleDelete(request: NextRequest, params: { route: string[] }) {
    try {
      requireSameOrigin(request);
      const parsed = parseRoute(params.route);
      if (!parsed?.slug) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await enforceWriteRateLimit(cimisyConfig, actor);
      const def = cimisyConfig.collectionsByKey[parsed.contentKey];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.contentKey}"` }, { status: 404 });

      actor.requirePermission("write", `${def.directory}/${parsed.slug}${def.extension}`);
      const { ref, publish } = await resolveWriteRef(actor, parsed.contentKey, parsed.slug);

      const body = await parseJsonBody(request, deleteEntryBodySchema).catch(() => ({ baseVersion: null }));
      const result = await deleteEntry(cimisyConfig.source, def, parsed.slug, {
        baseVersion: body.baseVersion ?? null,
        author: actor.author,
        message: `Delete ${parsed.contentKey}/${parsed.slug}`,
        ref,
      });
      if (result.conflict) {
        return NextResponse.json({ error: "Version conflict", conflict: result.conflict }, { status: 409 });
      }
      return NextResponse.json({ ok: true, publish });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /** Admin-only: lists the user roster (see rbac/user-store.ts). Local mode has no roster — 404, same as the auth routes. */
  async function handleUsersGet(request: NextRequest): Promise<NextResponse> {
    try {
      if (!isGithubSource(cimisyConfig.source)) {
        return NextResponse.json({ error: "User management requires the GitHub source." }, { status: 404 });
      }
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      actor.requirePermission("manageUsers", USERS_SENTINEL_PATH);
      const { users } = await readUserRoster(cimisyConfig.source);
      return NextResponse.json({ users });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Admin-only: sets (or clears, via `role: null`) one person's role.
   * Refuses to leave the roster with zero admins — the one hard-coded
   * safety rail in an otherwise fully config-driven RBAC system, since
   * "the admin locked themselves out" isn't recoverable without direct
   * repo access.
   */
  async function handleUsersPost(request: NextRequest): Promise<NextResponse> {
    try {
      requireSameOrigin(request);
      if (!isGithubSource(cimisyConfig.source)) {
        return NextResponse.json({ error: "User management requires the GitHub source." }, { status: 404 });
      }
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      actor.requirePermission("manageUsers", USERS_SENTINEL_PATH);
      await enforceWriteRateLimit(cimisyConfig, actor);

      const body = await parseJsonBody(request, setUserRoleBodySchema);
      const { users, version } = await readUserRoster(cimisyConfig.source, { bypassCache: true });
      const target = users.find((u) => u.githubId === body.githubId);
      if (!target) return NextResponse.json({ error: "Unknown user" }, { status: 404 });

      const remainingAdminsWithoutTarget = users.filter((u) => u.role === "admin" && u.githubId !== body.githubId).length;
      if (target.role === "admin" && body.role !== "admin" && remainingAdminsWithoutTarget === 0) {
        return NextResponse.json({ error: "Cannot remove the last admin." }, { status: 400 });
      }

      const now = new Date().toISOString();
      const updated = users.map((u) =>
        u.githubId === body.githubId ? { ...u, role: body.role, updatedAt: now, updatedBy: actor.login } : u,
      );
      const result = await writeUserRoster(
        cimisyConfig.source,
        updated,
        version,
        actor.author,
        `cimisy: set ${target.githubLogin}'s role to ${body.role ?? "(none)"}`,
        DEFAULT_REF,
      );
      if (result.conflict) return NextResponse.json({ error: "Version conflict, please retry" }, { status: 409 });
      return NextResponse.json({ ok: true, users: updated });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Resolves what a draft branch's content key + slug actually point at —
   * a collection entry, or a singleton (whose drafts always carry the
   * reserved SINGLETON_DRAFT_SLUG). Keys are unique across collections ∪
   * singletons (config() enforces it), so the lookup order can't be
   * ambiguous. Returns the repo path RBAC decisions are made against.
   */
  function resolveDraftTarget(
    contentKey: string,
    slug: string,
  ): { kind: "collection" | "singleton"; path: string } | null {
    const collectionDef = cimisyConfig.collectionsByKey[contentKey];
    if (collectionDef) return { kind: "collection", path: `${collectionDef.directory}/${slug}${collectionDef.extension}` };
    const singletonDef = cimisyConfig.singletonsByKey[contentKey];
    if (singletonDef && slug === SINGLETON_DRAFT_SLUG) return { kind: "singleton", path: singletonDef.path };
    return null;
  }

  /**
   * Lists open drafts (branches under `cimisy/`) the caller is allowed to
   * see: their own drafts (they wrote them), plus anyone's draft they have
   * `publish` permission to review. Per-PR failures (an unparseable branch
   * name, a since-removed collection) are skipped rather than aborting the
   * whole list — the same per-item error isolation collection-store.ts
   * uses for entry listing.
   */
  async function handleDraftsList(request: NextRequest): Promise<NextResponse> {
    try {
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!cimisyConfig.source.capabilities.pullRequests || !cimisyConfig.source.listChangeRequests) {
        return NextResponse.json({ drafts: [] });
      }

      const summaries = await cimisyConfig.source.listChangeRequests({ headPrefix: "cimisy/" });
      const drafts = [];
      for (const summary of summaries) {
        const parsed = parseDraftBranchName(summary.sourceRef);
        if (!parsed) continue;
        const target = resolveDraftTarget(parsed.contentKey, parsed.slug);
        if (!target) continue;
        let canMerge = false;
        try {
          actor.requirePermission("publish", target.path);
          canMerge = true;
        } catch {
          // not a reviewer for this entry — fine, might still be their own draft
        }
        const isOwnDraft = parsed.username === actor.login;
        if (!isOwnDraft && !canMerge) continue;
        drafts.push({
          id: summary.id,
          title: summary.title,
          url: summary.url,
          state: summary.state,
          updatedAt: summary.updatedAt,
          author: summary.author,
          kind: target.kind,
          contentKey: parsed.contentKey,
          slug: parsed.slug,
          branch: summary.sourceRef,
          canMerge,
        });
      }
      return NextResponse.json({ drafts });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Approves and merges a draft — the in-CMS counterpart to clicking
   * "Merge" on GitHub. The PR is looked up server-side by id (never a
   * client-supplied ref) so what actually gets merged is always whatever
   * the adapter itself reports as open under that id, not whatever the
   * client claims. This is the first route that enforces the `publish`
   * action (previously declared in DEFAULT_ROLES but never checked
   * anywhere) — reviewing/merging someone else's draft is exactly the
   * "publish" capability, distinct from "write" (which only lets you draft
   * your own changes).
   */
  async function handleDraftMerge(request: NextRequest, id: string): Promise<NextResponse> {
    try {
      requireSameOrigin(request);
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (
        !cimisyConfig.source.capabilities.pullRequests ||
        !cimisyConfig.source.listChangeRequests ||
        !cimisyConfig.source.mergeChangeRequest
      ) {
        return NextResponse.json({ error: "Merging drafts requires an adapter with pull request support." }, { status: 404 });
      }
      // Shares the write-rate-limit budget rather than a third key
      // namespace — merges are an infrequent reviewer action, not worth a
      // separately-tunable limiter.
      await enforceWriteRateLimit(cimisyConfig, actor);

      const summaries = await cimisyConfig.source.listChangeRequests({ headPrefix: "cimisy/" });
      const target = summaries.find((s) => s.id === id);
      if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const parsed = parseDraftBranchName(target.sourceRef);
      if (!parsed) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const draftTarget = resolveDraftTarget(parsed.contentKey, parsed.slug);
      if (!draftTarget) return NextResponse.json({ error: "Not found" }, { status: 404 });
      actor.requirePermission("publish", draftTarget.path);

      try {
        await cimisyConfig.source.mergeChangeRequest(id);
      } catch {
        return NextResponse.json(
          { error: "This draft could not be merged automatically — resolve conflicts on GitHub." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Uploads an image, sniffing its real format from bytes (never trusting
   * the client-claimed extension/content-type — see content/media.ts) and
   * writing it through the same draft-vs-direct envelope an entry save
   * uses, so an editor's upload lands on the same branch as the entry
   * they're editing.
   */
  async function handleMediaUpload(request: NextRequest): Promise<NextResponse> {
    try {
      requireSameOrigin(request);
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await enforceWriteRateLimit(cimisyConfig, actor);

      const body = await parseJsonBody(request, uploadMediaBodySchema);
      assertSafeSlug(body.slug);
      const configuredDirectories = getConfiguredImageDirectories(cimisyConfig);
      assertConfiguredDirectory(body.directory, configuredDirectories);

      const { type } = decodeUploadedImage(body.content);
      const path = buildMediaPath(body.directory, body.filename, type.extension);
      actor.requirePermission("write", path);

      if (!cimisyConfig.collectionsByKey[body.targetKey] && !cimisyConfig.singletonsByKey[body.targetKey]) {
        return NextResponse.json({ error: `Unknown content key "${body.targetKey}"` }, { status: 404 });
      }

      const { ref, publish } = await resolveWriteRef(actor, body.targetKey, body.slug);

      const result = await cimisyConfig.source.commitChange({
        ref,
        baseVersion: null, // a fresh randomized filename "already existing" would mean a genuine collision — surfaced below, not silently retried/overwritten
        message: `Upload ${path}`,
        author: actor.author,
        writes: [{ path, content: body.content, encoding: "base64" }],
      });
      if (result.conflict) {
        return NextResponse.json({ error: "A file with this name already exists — please try again." }, { status: 409 });
      }
      return NextResponse.json({ path, contentType: type.contentType, publish });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /** Lists uploaded files under one configured image directory — the browse-existing picker in the image field UI. */
  async function handleMediaList(request: NextRequest): Promise<NextResponse> {
    try {
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const url = new URL(request.url);
      const directory = url.searchParams.get("directory");
      if (!directory) return NextResponse.json({ error: 'Missing "directory" query parameter.' }, { status: 400 });
      const configuredDirectories = getConfiguredImageDirectories(cimisyConfig);
      assertConfiguredDirectory(directory, configuredDirectories);
      actor.requirePermission("read", directory);

      const ref = resolveSafeRef(url.searchParams.get("ref"));
      const files = await cimisyConfig.source.list(directory, ref);
      return NextResponse.json({ files });
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * Streams an uploaded file's raw bytes through the API (rather than
   * requiring direct repo access) — this is how the admin UI shows
   * thumbnails for images on a draft branch that was never deployed. Path
   * is confined to configured image directories independent of RBAC (a
   * `read` rule of "**" would otherwise let this double as a generic
   * repo-file-exfiltration endpoint), and the response always carries
   * X-Content-Type-Options: nosniff since Content-Type here is
   * best-effort (sniffed from bytes, or the adapter's own guess).
   */
  async function handleMediaRaw(request: NextRequest): Promise<NextResponse> {
    try {
      const actor = await resolveActor(request, cimisyConfig);
      if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const url = new URL(request.url);
      const path = url.searchParams.get("path");
      if (!path) return NextResponse.json({ error: 'Missing "path" query parameter.' }, { status: 400 });
      assertSafeRepoPath(path);
      const configuredDirectories = getConfiguredImageDirectories(cimisyConfig);
      assertPathUnderConfiguredDirectory(path, configuredDirectories);
      actor.requirePermission("read", path);

      const ref = resolveSafeRef(url.searchParams.get("ref"));
      if (!cimisyConfig.source.readRaw) {
        return NextResponse.json({ error: "Media reads require an adapter with raw file support." }, { status: 404 });
      }
      const raw = await cimisyConfig.source.readRaw(path, ref);
      if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });

      const buffer = Buffer.from(raw.content);
      const contentType = raw.contentType ?? sniffImageType(buffer)?.contentType ?? "application/octet-stream";
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": contentType,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch (err) {
      return errorResponse(err);
    }
  }

  // Typed strictly as a Promise to match Next 15's route-handler type
  // generation (next build validates the exported GET/POST/PUT/DELETE
  // against a Promise-only `params` type). `await` also resolves a
  // plain object correctly (awaiting a non-thenable value just yields
  // that value), so this still works at runtime under Next 14, which
  // passes `params` synchronously.
  type RouteParams = Promise<{ route: string[] }>;

  return {
    GET: async (request: NextRequest, context: { params: RouteParams }) => {
      const { route } = await context.params;
      if (route[0] === "auth") {
        const authResponse = await handleAuth(request, route[1]);
        if (authResponse) return authResponse;
      }
      if (route[0] === "preview" && route[1] === "enable") return handlePreviewEnable(request, cimisyConfig);
      if (route[0] === "preview" && route[1] === "disable") return handlePreviewDisable(request);
      if (route[0] === "users") return handleUsersGet(request);
      if (route[0] === "drafts") return handleDraftsList(request);
      if (route[0] === "media" && route[1] === "raw") return handleMediaRaw(request);
      if (route[0] === "media") return handleMediaList(request);
      if (route[0] === "singletons") {
        const parsed = parseSingletonRoute(route);
        if (!parsed) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return parsed.history
          ? handleSingletonHistory(request, parsed.contentKey)
          : handleSingletonGet(request, parsed.contentKey);
      }
      if (route[3] === "history") return handleHistory(request, { route });
      return handleGet(request, { route });
    },
    POST: async (request: NextRequest, context: { params: RouteParams }) => {
      const { route } = await context.params;
      if (route[0] === "auth") {
        const authResponse = await handleAuth(request, route[1]);
        if (authResponse) return authResponse;
      }
      if (route[0] === "users") return handleUsersPost(request);
      if (route[0] === "drafts") {
        const parsed = parseDraftMergeRoute(route);
        if (!parsed) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return handleDraftMerge(request, parsed.id);
      }
      if (route[0] === "media") return handleMediaUpload(request);
      if (route[0] === "singletons") {
        const parsed = parseSingletonRoute(route);
        if (!parsed || parsed.history) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return handleSingletonPut(request, parsed.contentKey);
      }
      return handlePost(request, { route });
    },
    PUT: async (request: NextRequest, context: { params: RouteParams }) => {
      const params = await context.params;
      if (params.route[0] === "singletons") {
        const parsed = parseSingletonRoute(params.route);
        if (!parsed || parsed.history) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return handleSingletonPut(request, parsed.contentKey);
      }
      return handlePost(request, params);
    },
    DELETE: async (request: NextRequest, context: { params: RouteParams }) =>
      handleDelete(request, await context.params),
  };
}
