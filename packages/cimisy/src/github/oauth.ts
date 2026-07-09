import "server-only";
import { CimisyError } from "../shared/errors.js";

export interface GithubIdentity {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  // No extra `scope` requested: this is identity-only (who is logging in).
  // All repo reads/writes happen via the App installation token, never with
  // a scoped user access token, so there's nothing broader to ask for.
  return url.toString();
}

/**
 * Exchanges an OAuth `code` for a short-lived user access token, uses it
 * exactly once to fetch the user's identity, and then discards it — the
 * user's own GitHub token is never persisted (not in the session cookie,
 * not anywhere server-side). All subsequent repo access goes through the
 * App installation token instead (see github/app-auth.ts).
 */
export async function exchangeCodeForIdentity(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GithubIdentity> {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    throw new CimisyError("GitHub OAuth token exchange failed.", "OAUTH_EXCHANGE_FAILED");
  }
  const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) {
    throw new CimisyError(`GitHub OAuth token exchange failed: ${tokenBody.error ?? "no access_token"}`, "OAUTH_EXCHANGE_FAILED");
  }

  const userResponse = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!userResponse.ok) {
    throw new CimisyError("Could not fetch GitHub user identity.", "OAUTH_USER_FETCH_FAILED");
  }
  const user = (await userResponse.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
  };
  return { id: String(user.id), login: user.login, name: user.name, email: user.email };
}
