import "server-only";
import { cookies, draftMode } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { CimisyConfig } from "../config/define-config.js";
import { draftBranchName, parseDraftBranchName } from "../shared/branch-name.js";
import { DEFAULT_REF, resolveActor } from "./actor.js";

export const PREVIEW_REF_COOKIE_NAME = "cimisy_preview_ref";

const PREVIEW_REF_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/**
 * Only ever redirects to a same-origin relative path. Accepting an
 * absolute or protocol-relative ("//evil.com") URL here would turn this
 * trusted, authenticated endpoint into an open redirect — a link through
 * it could land a signed-in editor on an attacker-controlled page.
 */
function safeRedirectPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/**
 * Enables Next.js Draft Mode plus a cimisy-specific cookie carrying which
 * ref (default branch, or a draft branch) the Reader should read from for
 * the rest of this preview session. Gated by the same identity+RBAC check
 * as the admin API (see next/actor.ts) — "can I read this content" is the
 * same question whether it's for the admin panel or a preview link.
 *
 * An optional `?ref=` lets a reviewer preview someone ELSE's draft (the
 * Drafts screen, M5) — without it, the ref is always derived from the
 * *viewer's own* identity via draftBranchName, which only ever resolves to
 * a branch the viewer themself would draft on. `ref` must parse as a
 * well-formed draft branch for the exact collection/slug being requested
 * (never trusted as an arbitrary ref straight from the client), and the
 * viewer still needs `read` on that entry — same check either way.
 */
export async function handlePreviewEnable(request: NextRequest, cimisyConfig: CimisyConfig): Promise<NextResponse> {
  const actor = await resolveActor(request, cimisyConfig);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const collectionName = request.nextUrl.searchParams.get("collection");
  const slug = request.nextUrl.searchParams.get("slug");
  const redirectTo = safeRedirectPath(request.nextUrl.searchParams.get("redirectTo"));
  const refParam = request.nextUrl.searchParams.get("ref");
  if (!collectionName || !slug) {
    return NextResponse.json({ error: "\"collection\" and \"slug\" query params are required." }, { status: 400 });
  }
  const def = cimisyConfig.collections[collectionName];
  if (!def) return NextResponse.json({ error: `Unknown collection "${collectionName}"` }, { status: 404 });

  try {
    actor.requirePermission("read", `${def.directory}/${slug}${def.extension}`);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let ref: string;
  if (refParam) {
    const parsed = parseDraftBranchName(refParam);
    if (!parsed || parsed.collectionName !== collectionName || parsed.slug !== slug) {
      return NextResponse.json({ error: "Invalid ref." }, { status: 400 });
    }
    ref = refParam;
  } else {
    // Direct-publish roles have no separate draft state — their content is
    // always on the default branch, so "preview" is just the live ref.
    ref = actor.directPublish ? DEFAULT_REF : draftBranchName(actor.login, collectionName, slug);
  }

  const dm = await draftMode();
  dm.enable();
  const response = NextResponse.redirect(new URL(redirectTo, request.nextUrl.origin));
  response.cookies.set(PREVIEW_REF_COOKIE_NAME, ref, PREVIEW_REF_COOKIE_OPTIONS);
  return response;
}

export async function handlePreviewDisable(request: NextRequest): Promise<NextResponse> {
  const redirectTo = safeRedirectPath(request.nextUrl.searchParams.get("redirectTo"));
  const dm = await draftMode();
  dm.disable();
  const response = NextResponse.redirect(new URL(redirectTo, request.nextUrl.origin));
  response.cookies.delete(PREVIEW_REF_COOKIE_NAME);
  return response;
}

/**
 * Used by the Reader (see next/reader.ts) to decide which ref to query.
 * Returns null when draft mode isn't active — callers fall back to the
 * default branch, i.e. normal published-content behavior.
 */
export async function getPreviewRef(): Promise<string | null> {
  const dm = await draftMode();
  if (!dm.isEnabled) return null;
  const cookieStore = await cookies();
  return cookieStore.get(PREVIEW_REF_COOKIE_NAME)?.value ?? null;
}
