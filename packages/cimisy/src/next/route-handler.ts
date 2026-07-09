import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import type { CimisyConfig } from "../config/define-config.js";
import { deleteEntry, listEntries, readEntry, resolveEntrySlug, writeEntry } from "../content/collection-store.js";
import { ensureDraftBranchAndPr } from "../content/draft-workflow.js";
import { draftBranchName } from "../shared/branch-name.js";
import { CimisyError, ConflictError, ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "../shared/errors.js";
import { isGithubSource } from "../shared/github-source-shape.js";
import { assertSafeSlug, entryPathForSlug } from "../shared/slug.js";
import type { Actor } from "./actor.js";
import { DEFAULT_REF, resolveActor } from "./actor.js";
import { handleCallback, handleLogin, handleLogout } from "./auth-routes.js";
import { requireSameOrigin } from "./csrf.js";
import { handlePreviewDisable, handlePreviewEnable } from "./draft-mode.js";
import { deleteEntryBodySchema, writeEntryBodySchema } from "./request-schemas.js";

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
function parseRoute(routeParams: string[]): { collectionName: string; slug: string | null } | null {
  if (routeParams[0] !== "collections" || !routeParams[1]) return null;
  if (routeParams.length > 3) return null;
  const slug = routeParams[2] ?? null;
  if (slug !== null) assertSafeSlug(slug);
  return { collectionName: routeParams[1], slug };
}

function parseHistoryRoute(routeParams: string[]): { collectionName: string; slug: string } | null {
  if (routeParams[0] !== "collections" || !routeParams[1] || !routeParams[2] || routeParams[3] !== "history") return null;
  if (routeParams.length !== 4) return null;
  assertSafeSlug(routeParams[2]);
  return { collectionName: routeParams[1], slug: routeParams[2] };
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

/** Keyed by identity (not IP): the abuse case here is a compromised/buggy authenticated client hammering writes, not anonymous traffic — IP-keying would be trivially bypassed by anyone who can already authenticate. */
async function enforceWriteRateLimit(cimisyConfig: CimisyConfig, actor: Actor): Promise<void> {
  const limiter = cimisyConfig.rateLimiter;
  if (!limiter) return;
  const result = await limiter.consume(`write:${actor.author.id}`);
  if (!result.allowed) {
    throw new RateLimitedError("Too many write requests — please slow down.", result.retryAfterMs);
  }
}

export function createCimisyHandler(cimisyConfig: CimisyConfig) {
  async function handleAuth(request: NextRequest, action: string | undefined): Promise<NextResponse | null> {
    if (action === "me") {
      const actor = await resolveActor(request, cimisyConfig);
      return NextResponse.json(
        actor ? { authenticated: true, user: actor.author, role: actor.roleName } : { authenticated: false },
      );
    }
    if (!isGithubSource(cimisyConfig.source)) {
      return NextResponse.json({ error: "Auth routes require the GitHub source." }, { status: 404 });
    }
    if (action === "login") return handleLogin(request, cimisyConfig.source);
    if (action === "callback") return handleCallback(request, cimisyConfig.source, cimisyConfig.rateLimiter);
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
      const def = cimisyConfig.collections[parsed.collectionName];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.collectionName}"` }, { status: 404 });

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
      const def = cimisyConfig.collections[parsed.collectionName];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.collectionName}"` }, { status: 404 });
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
   * Direct-publish roles write straight to the default branch. Everyone
   * else drafts on a deterministic per-user/per-entry branch (created and
   * PR'd on first save, just committed to on every save after that) — this
   * is simultaneously the draft mechanism and the role-gated publish
   * mechanism described in the plan: branch = draft, merge = publish, and
   * cimisy never reimplements merge/approval — that's GitHub's own PR UI.
   */
  async function resolveWriteRef(
    actor: Actor,
    collectionName: string,
    slug: string,
  ): Promise<{ ref: string; publish: { status: "direct" } | { status: "draft"; branch: string; pullRequestUrl: string } }> {
    if (actor.directPublish) return { ref: DEFAULT_REF, publish: { status: "direct" } };
    const branch = draftBranchName(actor.login, collectionName, slug);
    const draft = await ensureDraftBranchAndPr(
      cimisyConfig.source,
      branch,
      DEFAULT_REF,
      `cimisy: ${collectionName}/${slug}`,
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
      const def = cimisyConfig.collections[parsed.collectionName];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.collectionName}"` }, { status: 404 });

      const body = await parseJsonBody(request, writeEntryBodySchema);
      const slug = resolveEntrySlug(def, body.values, parsed.slug ?? undefined);
      actor.requirePermission("write", `${def.directory}/${slug}${def.extension}`);

      const { ref, publish } = await resolveWriteRef(actor, parsed.collectionName, slug);

      const { result, slug: writtenSlug } = await writeEntry(cimisyConfig.source, def, {
        slug,
        values: body.values,
        baseVersion: body.baseVersion ?? null,
        author: actor.author,
        message: parsed.slug ? `Update ${parsed.collectionName}/${slug}` : `Create ${parsed.collectionName}/${slug}`,
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
      const def = cimisyConfig.collections[parsed.collectionName];
      if (!def) return NextResponse.json({ error: `Unknown collection "${parsed.collectionName}"` }, { status: 404 });

      actor.requirePermission("write", `${def.directory}/${parsed.slug}${def.extension}`);
      const { ref, publish } = await resolveWriteRef(actor, parsed.collectionName, parsed.slug);

      const body = await parseJsonBody(request, deleteEntryBodySchema).catch(() => ({ baseVersion: null }));
      const result = await deleteEntry(cimisyConfig.source, def, parsed.slug, {
        baseVersion: body.baseVersion ?? null,
        author: actor.author,
        message: `Delete ${parsed.collectionName}/${parsed.slug}`,
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

  // Next 14 passes `params` as a plain object; Next 15 made it a Promise.
  // `await` resolves either form correctly (awaiting a non-thenable value
  // just yields that value), so one handler shape supports both.
  type RouteParams = { route: string[] } | Promise<{ route: string[] }>;

  return {
    GET: async (request: NextRequest, context: { params: RouteParams }) => {
      const { route } = await context.params;
      if (route[0] === "auth") {
        const authResponse = await handleAuth(request, route[1]);
        if (authResponse) return authResponse;
      }
      if (route[0] === "preview" && route[1] === "enable") return handlePreviewEnable(request, cimisyConfig);
      if (route[0] === "preview" && route[1] === "disable") return handlePreviewDisable(request);
      if (route[3] === "history") return handleHistory(request, { route });
      return handleGet(request, { route });
    },
    POST: async (request: NextRequest, context: { params: RouteParams }) => {
      const { route } = await context.params;
      if (route[0] === "auth") {
        const authResponse = await handleAuth(request, route[1]);
        if (authResponse) return authResponse;
      }
      return handlePost(request, { route });
    },
    PUT: async (request: NextRequest, context: { params: RouteParams }) => handlePost(request, await context.params),
    DELETE: async (request: NextRequest, context: { params: RouteParams }) =>
      handleDelete(request, await context.params),
  };
}
