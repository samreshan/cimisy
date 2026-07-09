import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface SessionPayload {
  githubUserId: string;
  githubLogin: string;
  name: string | null;
  email: string | null;
}

export const SESSION_COOKIE_NAME = "cimisy_session";
export const OAUTH_STATE_COOKIE_NAME = "cimisy_oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10; // 10 minutes — just long enough for the redirect round trip

// `secure` is conditional on NODE_ENV rather than always-on because a
// secure-only cookie is silently dropped by the browser over plain
// http://localhost, which is how this app runs in local dev.
const baseCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export const SESSION_COOKIE_OPTIONS = { ...baseCookieOptions, maxAge: SESSION_MAX_AGE_SECONDS };
export const OAUTH_STATE_COOKIE_OPTIONS = { ...baseCookieOptions, maxAge: OAUTH_STATE_MAX_AGE_SECONDS };

export async function createSessionToken(payload: SessionPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(key);
}

/**
 * Any failure mode — expired, tampered signature, wrong secret, malformed
 * token, unexpected payload shape — is treated identically: no session.
 * The algorithm is pinned explicitly (rather than trusting the token's own
 * header) to rule out alg-confusion attacks.
 */
export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (typeof payload.githubUserId !== "string" || typeof payload.githubLogin !== "string") {
      return null;
    }
    return {
      githubUserId: payload.githubUserId,
      githubLogin: payload.githubLogin,
      name: typeof payload.name === "string" ? payload.name : null,
      email: typeof payload.email === "string" ? payload.email : null,
    };
  } catch {
    return null;
  }
}

export function generateOauthState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison — state values are compared, not secrets, but this costs nothing and rules out timing side-channels by habit. */
export function oauthStateMatches(cookieValue: string | undefined, queryValue: string | null): boolean {
  if (!cookieValue || !queryValue) return false;
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(queryValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
