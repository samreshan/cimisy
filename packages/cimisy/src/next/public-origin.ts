import type { NextRequest } from "next/server";
import { CIMISY_ENV_VARS } from "../shared/github-env.js";

/**
 * The origin cimisy should treat as "this app's public address".
 *
 * Everything used to derive this from `request.nextUrl.origin` — the URL
 * the server saw. That's correct for a plain deployment and wrong in two
 * situations that matter:
 *
 * 1. **Vercel preview deployments.** Every preview gets a unique hostname
 *    (`myapp-git-branch-team.vercel.app`). The OAuth `redirect_uri` is
 *    built from the origin, GitHub Apps don't support wildcard callback
 *    URLs, and only ~10 can be registered — so sign-in fails on every
 *    preview with a redirect-URI mismatch.
 * 2. **A reverse proxy that rewrites `Host`.** The server's view of the
 *    origin then differs from the browser's, which breaks both the OAuth
 *    round trip and the same-origin CSRF check.
 *
 * Resolution order, most explicit first:
 * - `CIMISY_PUBLIC_URL` — set by the deployer, always wins.
 * - `VERCEL_PROJECT_PRODUCTION_URL` — Vercel's *stable production* domain
 *   (not `VERCEL_URL`, which is per-deployment and would reintroduce the
 *   preview problem). Injected automatically unless the project turned
 *   system environment variables off.
 * - the request's own origin — the previous behavior, unchanged.
 *
 * Only trusted inputs feed this: deployer-set configuration, never a
 * request header. `X-Forwarded-Host` is deliberately *not* consulted —
 * it's attacker-controllable on a directly-reachable origin, and this
 * value gates the CSRF comparison.
 */

/** Deployer-configured origin, if any. Null when nothing is set or the value isn't a usable absolute URL. */
export function configuredPublicOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = normalizeOrigin(env[CIMISY_ENV_VARS.publicUrl]);
  if (explicit) return explicit;

  // Vercel supplies this bare (no scheme), e.g. "myapp.vercel.app".
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return normalizeOrigin(vercel.startsWith("http") ? vercel : `https://${vercel}`);

  return null;
}

/** The configured origin when there is one, else the origin the request actually arrived on. */
export function resolvePublicOrigin(request: NextRequest, env: Record<string, string | undefined> = process.env): string {
  return configuredPublicOrigin(env) ?? request.nextUrl.origin;
}

/**
 * Origins a same-origin request may legitimately claim. Both entries are
 * trusted — one is the address the request actually reached, the other is
 * deployer configuration — so accepting either widens nothing an attacker
 * controls, while letting the admin UI keep working on a preview
 * deployment whose host differs from the configured production domain.
 */
export function allowedOrigins(request: NextRequest, env: Record<string, string | undefined> = process.env): string[] {
  const configured = configuredPublicOrigin(env);
  const requestOrigin = request.nextUrl.origin;
  return configured && configured !== requestOrigin ? [requestOrigin, configured] : [requestOrigin];
}

function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
