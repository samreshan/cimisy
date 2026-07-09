import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildAuthorizeUrl, exchangeCodeForIdentity } from "../github/oauth.js";
import { clientIpFromRequest, type RateLimiter } from "../security/rate-limit.js";
import type { GithubIntegratedSource } from "../shared/github-source-shape.js";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_OPTIONS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  createSessionToken,
  generateOauthState,
  oauthStateMatches,
} from "./session.js";

const DEFAULT_POST_LOGIN_REDIRECT = "/admin";

export async function handleLogin(request: NextRequest, source: GithubIntegratedSource): Promise<NextResponse> {
  const state = generateOauthState();
  const redirectUri = new URL("/api/cimisy/auth/callback", request.nextUrl.origin).toString();
  const authorizeUrl = buildAuthorizeUrl({ clientId: source.credentials.clientId, redirectUri, state });
  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, state, OAUTH_STATE_COOKIE_OPTIONS);
  return response;
}

export async function handleCallback(
  request: NextRequest,
  source: GithubIntegratedSource,
  rateLimiter?: RateLimiter,
): Promise<NextResponse> {
  // IP-keyed (not identity-keyed): there's no identity yet at this point
  // in the flow — this is exactly the endpoint an attacker would hammer
  // to brute-force/abuse the token exchange before any auth exists.
  // Returned as a NextResponse directly (not thrown) — this function
  // isn't wrapped in a try/catch anywhere upstream, unlike the admin API
  // handlers, so it's responsible for converting its own error cases.
  if (rateLimiter) {
    const result = await rateLimiter.consume(`auth:${clientIpFromRequest(request)}`);
    if (!result.allowed) {
      const headers = result.retryAfterMs ? { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) } : undefined;
      return NextResponse.json({ error: "Too many sign-in attempts — please slow down." }, { status: 429, headers });
    }
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;

  if (!code || !oauthStateMatches(stateCookie, state)) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  const redirectUri = new URL("/api/cimisy/auth/callback", request.nextUrl.origin).toString();
  let identity;
  try {
    identity = await exchangeCodeForIdentity({
      clientId: source.credentials.clientId,
      clientSecret: source.credentials.clientSecret,
      code,
      redirectUri,
    });
  } catch {
    return NextResponse.json({ error: "GitHub sign-in failed." }, { status: 401 });
  }

  const sessionToken = await createSessionToken(
    { githubUserId: identity.id, githubLogin: identity.login, name: identity.name, email: identity.email },
    source.sessionSecret,
  );

  const response = NextResponse.redirect(new URL(DEFAULT_POST_LOGIN_REDIRECT, request.nextUrl.origin));
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, SESSION_COOKIE_OPTIONS);
  response.cookies.delete(OAUTH_STATE_COOKIE_NAME);
  return response;
}

export async function handleLogout(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
