import type { NextRequest } from "next/server";
import { ForbiddenError } from "../shared/errors.js";

/**
 * CSRF protection for the admin API's state-changing routes.
 *
 * The session cookie is already `sameSite: "lax"`, which browsers refuse
 * to attach to cross-site POST/PUT/DELETE requests — that alone blocks
 * most CSRF here. This is a second, independent layer (defense-in-depth,
 * same posture as everywhere else in this codebase): verify the request's
 * own `Origin` (falling back to `Referer`) matches the app's origin.
 * Unlike token-based CSRF protection, this needs no client-side changes
 * to the admin UI's fetch calls and no per-form token to thread through.
 *
 * Fails closed: a state-changing request with neither header present is
 * rejected rather than allowed. Real browser requests to these endpoints
 * always carry one of these headers; a request missing both is either a
 * non-browser client (which should be sending the header itself) or an
 * attack technique trying to strip them.
 */
export function requireSameOrigin(request: NextRequest): void {
  const expectedOrigin = request.nextUrl.origin;
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin !== expectedOrigin) {
      throw new ForbiddenError(`Cross-origin request rejected (Origin "${origin}" does not match "${expectedOrigin}").`);
    }
    return;
  }
  const referer = request.headers.get("referer");
  if (referer) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      throw new ForbiddenError("Cross-origin request rejected (unparseable Referer).");
    }
    if (refererOrigin !== expectedOrigin) {
      throw new ForbiddenError(`Cross-origin request rejected (Referer "${refererOrigin}" does not match "${expectedOrigin}").`);
    }
    return;
  }
  throw new ForbiddenError("Cross-origin request rejected (no Origin or Referer header present).");
}
