import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubSource } from "../../adapters/github/adapter.js";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { DEFAULT_ROLE_MAPPING } from "../../config/define-config.js";
import { readUserRoster } from "../../rbac/user-store.js";
import { createInMemoryRateLimiter } from "../../security/rate-limit.js";
import type { GithubIntegratedSource } from "../../shared/github-source-shape.js";
import { handleCallback, handleLogin } from "../auth-routes.js";
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from "../session.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function makeSource(fake: FakeGithubApi): GithubIntegratedSource {
  return githubSource({
    repo: `${fake.owner}/${fake.repo}`,
    branch: "main",
    appId: "1",
    privateKey,
    clientId: "client-id",
    clientSecret: "client-secret",
    sessionSecret: "session-secret-0123456789abcdef0",
  });
}

interface FakeIdentity {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

/** Layers OAuth token-exchange + user-identity fetch mocking on top of the fake GitHub REST API (fake.install() must already be active) so handleCallback's full flow — token exchange, identity fetch, then the App-authenticated roster read/write — can run end to end. */
function installOauthFetch(identity: FakeIdentity): void {
  const repoFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url.includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_faketoken" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(identity), { status: 200 });
    }
    return repoFetch(input, init);
  }) as typeof fetch;
}

function callbackRequest(state: string): NextRequest {
  const url = new URL(`http://x/api/cimisy/auth/callback?code=the-code&state=${state}`);
  const req = new NextRequest(url);
  req.cookies.set(OAUTH_STATE_COOKIE_NAME, state);
  return req;
}

function sessionCookieFromResponse(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.split(";")[0];
}

describe("auth-routes handleCallback", () => {
  let fake: FakeGithubApi;
  let source: GithubIntegratedSource;

  beforeEach(() => {
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    source = makeSource(fake);
  });

  afterEach(() => {
    fake.restore();
  });

  it("bootstraps the very first sign-in as admin when their GitHub collaborator permission maps to admin", async () => {
    fake.setCollaboratorPermission("octocat", "admin");
    installOauthFetch({ id: 42, login: "octocat", name: "The Octocat", email: null });

    const res = await handleCallback(callbackRequest("state-1"), source, undefined, DEFAULT_ROLE_MAPPING);
    expect(res.status).toBe(307); // redirect on success
    expect(sessionCookieFromResponse(res)).toContain(SESSION_COOKIE_NAME);

    const { users } = await readUserRoster(source, { bypassCache: true });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ githubId: "42", githubLogin: "octocat", role: "admin" });
  });

  it("registers a pending user (no role) when the roster already has an admin", async () => {
    fake.setCollaboratorPermission("first-admin", "admin");
    installOauthFetch({ id: 1, login: "first-admin", name: null, email: null });
    await handleCallback(callbackRequest("state-a"), source, undefined, DEFAULT_ROLE_MAPPING);

    fake.setCollaboratorPermission("newcomer", "admin"); // even with admin GitHub permission...
    installOauthFetch({ id: 2, login: "newcomer", name: null, email: null });
    const res = await handleCallback(callbackRequest("state-b"), source, undefined, DEFAULT_ROLE_MAPPING);
    expect(res.status).toBe(307);

    const { users } = await readUserRoster(source, { bypassCache: true });
    expect(users).toHaveLength(2);
    const newcomer = users.find((u) => u.githubId === "2");
    expect(newcomer?.role).toBeNull(); // ...they still land pending, not admin
  });

  it("rejects a mismatched or missing OAuth state before ever calling GitHub", async () => {
    installOauthFetch({ id: 1, login: "someone", name: null, email: null });
    const url = new URL("http://x/api/cimisy/auth/callback?code=the-code&state=wrong-state");
    const req = new NextRequest(url);
    req.cookies.set(OAUTH_STATE_COOKIE_NAME, "expected-state");

    const res = await handleCallback(req, source, undefined, DEFAULT_ROLE_MAPPING);
    expect(res.status).toBe(400);

    const { users } = await readUserRoster(source, { bypassCache: true });
    expect(users).toEqual([]); // no roster entry was ever created
  });
});

describe("auth-routes handleLogin", () => {
  let fake: FakeGithubApi;
  let source: GithubIntegratedSource;

  beforeEach(() => {
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    source = makeSource(fake);
  });

  afterEach(() => {
    fake.restore();
  });

  function loginRequest(): NextRequest {
    return new NextRequest(new URL("http://x/api/cimisy/auth/login"));
  }

  it("redirects to GitHub's authorize URL when no rate limiter is configured", async () => {
    const res = await handleLogin(loginRequest(), source);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("github.com/login/oauth/authorize");
  });

  it("is rate-limited the same way the callback is, keyed by IP", async () => {
    const rateLimiter = createInMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    const first = await handleLogin(loginRequest(), source, rateLimiter);
    expect(first.status).toBe(307);
    const second = await handleLogin(loginRequest(), source, rateLimiter);
    expect(second.status).toBe(429);
  });
});
