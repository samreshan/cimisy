import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import { collection, config, fields } from "../../config/index.js";
import type { CimisyConfig } from "../../config/define-config.js";
import { createInMemoryRateLimiter } from "../../security/rate-limit.js";
import { createCimisyHandler } from "../route-handler.js";
import { createSessionToken } from "../session.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

const SESSION_SECRET = "test-session-secret";

function buildConfig(fake: FakeGithubApi): CimisyConfig {
  return config({
    source: githubSource({
      repo: `${fake.owner}/${fake.repo}`,
      branch: "main",
      appId: "1",
      privateKey,
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: SESSION_SECRET,
    }),
    collections: {
      posts: collection({
        label: "Posts",
        path: "content/posts/*.mdx",
        slugField: "slug",
        schema: {
          title: fields.text({ label: "Title", validation: { isRequired: true } }),
          slug: fields.slug({ source: "title" }),
        },
      }),
    },
  });
}

async function sessionCookieFor(login: string, userId: string): Promise<string> {
  const token = await createSessionToken(
    { githubUserId: userId, githubLogin: login, name: login, email: null },
    SESSION_SECRET,
  );
  return `cimisy_session=${token}`;
}

/** Seeds the .cimisy/users.yaml roster directly (bypassing the real OAuth-login-creates-a-user flow, which is exercised separately in user-store.test.ts / auth-routes.test.ts) — the RBAC-focused tests here just need a given identity to already have a given role. */
function seedRoster(fake: FakeGithubApi, records: Array<{ githubId: string; githubLogin: string; role: string | null }>): void {
  const now = new Date(0).toISOString();
  fake.seedFile(
    ".cimisy/users.yaml",
    stringifyYaml(
      records.map((r) => ({
        githubId: r.githubId,
        githubLogin: r.githubLogin,
        name: r.githubLogin,
        role: r.role,
        addedAt: now,
        updatedAt: now,
        updatedBy: "test",
      })),
    ),
  );
}

// State-changing requests get a same-origin `Origin` header by default
// (matching how a real same-origin fetch() from the admin UI behaves),
// so existing tests don't need to know about the CSRF check to pass one.
// Tests that specifically exercise CSRF rejection pass their own
// mismatched `headers.origin` to override this.
function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  const parsedUrl = new URL(url, "http://localhost:3000");
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (["POST", "PUT", "DELETE"].includes(method) && !headers.has("origin")) {
    headers.set("origin", parsedUrl.origin);
  }
  return new NextRequest(parsedUrl, { ...init, headers });
}

describe("route-handler RBAC integration", () => {
  let fake: FakeGithubApi;
  let handler: ReturnType<typeof createCimisyHandler>;

  beforeEach(() => {
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    handler = createCimisyHandler(buildConfig(fake));
  });

  afterEach(() => {
    fake.restore();
  });

  it("rejects unauthenticated requests with 401, not silently as local mode", async () => {
    const res = await handler.GET(req("http://x/api/cimisy/collections/posts"), { params: { route: ["collections", "posts"] } });
    expect(res.status).toBe(401);
  });

  it("rejects a GitHub-authenticated user who has no assigned role (403)", async () => {
    const cookie = await sessionCookieFor("outsider", "1001");
    const res = await handler.GET(req("http://x/api/cimisy/collections/posts", { headers: { cookie } }), {
      params: { route: ["collections", "posts"] },
    });
    expect(res.status).toBe(403);
  });

  it("an admin-role user reads and publishes directly", async () => {
    seedRoster(fake, [{ githubId: "2001", githubLogin: "admin-user-1", role: "admin" }]);
    const cookie = await sessionCookieFor("admin-user-1", "2001");

    const getRes = await handler.GET(req("http://x/api/cimisy/collections/posts", { headers: { cookie } }), {
      params: { route: ["collections", "posts"] },
    });
    expect(getRes.status).toBe(200);

    const postRes = await handler.POST(
      req("http://x/api/cimisy/collections/posts", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { title: "Hello Admin" } }),
      }),
      { params: { route: ["collections", "posts"] } },
    );
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { publish: { status: string } };
    expect(postBody.publish.status).toBe("direct");
    expect(fake.filesOnBranch("main").has("content/posts/hello-admin.mdx")).toBe(true);
  });

  it("an editor-role user drafts via a branch + PR instead of publishing directly", async () => {
    seedRoster(fake, [{ githubId: "3001", githubLogin: "editor-user-1", role: "editor" }]);
    const cookie = await sessionCookieFor("editor-user-1", "3001");

    const postRes = await handler.POST(
      req("http://x/api/cimisy/collections/posts", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { title: "Hello Editor" } }),
      }),
      { params: { route: ["collections", "posts"] } },
    );
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { publish: { status: string; branch?: string; pullRequestUrl?: string } };
    expect(postBody.publish.status).toBe("draft");
    expect(postBody.publish.branch).toBe("cimisy/editor-user-1/posts/hello-editor");
    expect(postBody.publish.pullRequestUrl).toContain("/pull/");

    // The default branch must be untouched — this is the whole point of PR-gating.
    expect(fake.filesOnBranch("main").has("content/posts/hello-editor.mdx")).toBe(false);
    expect(fake.filesOnBranch("cimisy/editor-user-1/posts/hello-editor").has("content/posts/hello-editor.mdx")).toBe(true);
  });

  it("a viewer-role user cannot write, even to their own draft branch (403)", async () => {
    seedRoster(fake, [{ githubId: "4001", githubLogin: "viewer-user-1", role: "viewer" }]);
    const cookie = await sessionCookieFor("viewer-user-1", "4001");

    const postRes = await handler.POST(
      req("http://x/api/cimisy/collections/posts", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { title: "Should Not Land" } }),
      }),
      { params: { route: ["collections", "posts"] } },
    );
    expect(postRes.status).toBe(403);
    expect(fake.filesOnBranch("main").has("content/posts/should-not-land.mdx")).toBe(false);
  });

  it("IDOR regression: a forged client-supplied role/permission flag in the request body is ignored — only the server-resolved session role matters", async () => {
    seedRoster(fake, [{ githubId: "4002", githubLogin: "viewer-user-2", role: "viewer" }]);
    const cookie = await sessionCookieFor("viewer-user-2", "4002");

    const postRes = await handler.POST(
      req("http://x/api/cimisy/collections/posts", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        // Attacker forges role/isAdmin claims that no legitimate client
        // would ever need to send — the handler never reads these fields
        // from the body, so they must have zero effect.
        body: JSON.stringify({ values: { title: "Forged" }, role: "admin", isAdmin: true, directPublish: true }),
      }),
      { params: { route: ["collections", "posts"] } },
    );
    expect(postRes.status).toBe(403);
    expect(fake.filesOnBranch("main").has("content/posts/forged.mdx")).toBe(false);
  });

  it("repeated saves by the same editor land on the same draft branch/PR, not duplicates", async () => {
    seedRoster(fake, [{ githubId: "3002", githubLogin: "editor-user-2", role: "editor" }]);
    const cookie = await sessionCookieFor("editor-user-2", "3002");

    async function save(title: string, baseVersion: string | null) {
      return handler.POST(
        req("http://x/api/cimisy/collections/posts", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ values: { title, slug: "same-post" }, baseVersion }),
        }),
        { params: { route: ["collections", "posts"] } },
      );
    }

    const first = await save("First Version", null);
    const firstBody = (await first.json()) as { version: string; publish: { pullRequestUrl?: string } };
    const second = await save("Second Version", firstBody.version);
    const secondBody = (await second.json()) as { publish: { pullRequestUrl?: string } };

    expect(secondBody.publish.pullRequestUrl).toBe(firstBody.publish.pullRequestUrl);
    expect(fake.filesOnBranch("cimisy/editor-user-2/posts/same-post").get("content/posts/same-post.mdx")).toContain(
      "Second Version",
    );
  });

  it("delete also requires write permission and goes through the same draft workflow for non-direct-publish roles", async () => {
    seedRoster(fake, [
      { githubId: "2002", githubLogin: "admin-user-2", role: "admin" },
      { githubId: "4003", githubLogin: "viewer-user-3", role: "viewer" },
    ]);
    const adminCookie = await sessionCookieFor("admin-user-2", "2002");
    await handler.POST(
      req("http://x/api/cimisy/collections/posts", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { title: "To Delete" } }),
      }),
      { params: { route: ["collections", "posts"] } },
    );
    expect(fake.filesOnBranch("main").has("content/posts/to-delete.mdx")).toBe(true);

    const viewerCookie = await sessionCookieFor("viewer-user-3", "4003");
    const deleteRes = await handler.DELETE(
      req("http://x/api/cimisy/collections/posts/to-delete", { method: "DELETE", headers: { cookie: viewerCookie } }),
      { params: { route: ["collections", "posts", "to-delete"] } },
    );
    expect(deleteRes.status).toBe(403);
    expect(fake.filesOnBranch("main").has("content/posts/to-delete.mdx")).toBe(true); // untouched
  });

  describe("entry history (activity log)", () => {
    it("returns commit history for an entry when the adapter supports it", async () => {
      seedRoster(fake, [{ githubId: "2007", githubLogin: "admin-user-7", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-7", "2007");
      await handler.POST(
        req("http://x/api/cimisy/collections/posts", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ values: { title: "History Test" } }),
        }),
        { params: { route: ["collections", "posts"] } },
      );

      const res = await handler.GET(
        req("http://x/api/cimisy/collections/posts/history-test/history", { headers: { cookie } }),
        { params: { route: ["collections", "posts", "history-test", "history"] } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { supported: boolean; history: Array<{ message: string }> };
      expect(body.supported).toBe(true);
    });

    it("requires read permission on the entry, same as reading it directly", async () => {
      seedRoster(fake, [{ githubId: "4004", githubLogin: "viewer-user-4", role: "viewer" }]);
      const cookie = await sessionCookieFor("viewer-user-4", "4004");
      const res = await handler.GET(
        req("http://x/api/cimisy/collections/posts/anything/history", { headers: { cookie } }),
        { params: { route: ["collections", "posts", "anything", "history"] } },
      );
      // viewer role's default rules permit read everywhere, so this should
      // succeed (200) even though the entry itself may not exist — history
      // for a nonexistent path is just an empty list, not an error.
      expect(res.status).toBe(200);
    });

    it("rejects an unsafe slug in the history route instead of passing it through", async () => {
      seedRoster(fake, [{ githubId: "2008", githubLogin: "admin-user-8", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-8", "2008");
      const res = await handler.GET(
        req("http://x/api/cimisy/collections/posts/..%2F..%2Fetc%2Fpasswd/history", { headers: { cookie } }),
        { params: { route: ["collections", "posts", "../../etc/passwd", "history"] } },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("CSRF protection (Origin header verification)", () => {
    it("rejects a write from a mismatched Origin even with a valid session cookie", async () => {
      seedRoster(fake, [{ githubId: "2003", githubLogin: "admin-user-3", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-3", "2003");
      const res = await handler.POST(
        req("http://x/api/cimisy/collections/posts", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: "https://evil.com" },
          body: JSON.stringify({ values: { title: "CSRF Attempt" } }),
        }),
        { params: { route: ["collections", "posts"] } },
      );
      expect(res.status).toBe(403);
      expect(fake.filesOnBranch("main").has("content/posts/csrf-attempt.mdx")).toBe(false);
    });

    it("rejects a write with no Origin or Referer header at all", async () => {
      seedRoster(fake, [{ githubId: "2004", githubLogin: "admin-user-4", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-4", "2004");
      const bareRequest = new NextRequest(new URL("http://x/api/cimisy/collections/posts"), {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { title: "No Origin" } }),
      });
      const res = await handler.POST(bareRequest, { params: { route: ["collections", "posts"] } });
      expect(res.status).toBe(403);
    });

    it("accepts a write whose Referer (not Origin) matches, when Origin is absent", async () => {
      seedRoster(fake, [{ githubId: "2005", githubLogin: "admin-user-5", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-5", "2005");
      const refererRequest = new NextRequest(new URL("http://x/api/cimisy/collections/posts"), {
        method: "POST",
        headers: { cookie, "content-type": "application/json", referer: "http://x/admin/posts/new" },
        body: JSON.stringify({ values: { title: "Referer Fallback" } }),
      });
      const res = await handler.POST(refererRequest, { params: { route: ["collections", "posts"] } });
      expect(res.status).toBe(200);
    });

    it("does not apply CSRF checks to reads (GET)", async () => {
      seedRoster(fake, [{ githubId: "2006", githubLogin: "admin-user-6", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-6", "2006");
      const bareGet = new NextRequest(new URL("http://x/api/cimisy/collections/posts"), { headers: { cookie } });
      const res = await handler.GET(bareGet, { params: { route: ["collections", "posts"] } });
      expect(res.status).toBe(200);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 with a Retry-After header once a write exceeds the configured limit", async () => {
      const rateLimiter = createInMemoryRateLimiter({ limit: 2, windowMs: 10_000 });
      const limitedConfig = config({ ...buildConfig(fake), rateLimiter });
      const limitedHandler = createCimisyHandler(limitedConfig);

      seedRoster(fake, [{ githubId: "2009", githubLogin: "admin-user-9", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-9", "2009");

      async function save(title: string) {
        return limitedHandler.POST(
          req("http://x/api/cimisy/collections/posts", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ values: { title } }),
          }),
          { params: { route: ["collections", "posts"] } },
        );
      }

      expect((await save("First")).status).toBe(200);
      expect((await save("Second")).status).toBe(200);
      const third = await save("Third");
      expect(third.status).toBe(429);
      expect(third.headers.get("Retry-After")).toBeTruthy();
    });

    it("keys the limit by identity, so a different user is unaffected", async () => {
      const rateLimiter = createInMemoryRateLimiter({ limit: 1, windowMs: 10_000 });
      const limitedConfig = config({ ...buildConfig(fake), rateLimiter });
      const limitedHandler = createCimisyHandler(limitedConfig);

      seedRoster(fake, [
        { githubId: "2010", githubLogin: "admin-user-10", role: "admin" },
        { githubId: "2011", githubLogin: "admin-user-11", role: "admin" },
      ]);
      const cookieA = await sessionCookieFor("admin-user-10", "2010");
      const cookieB = await sessionCookieFor("admin-user-11", "2011");

      async function save(cookie: string, title: string) {
        return limitedHandler.POST(
          req("http://x/api/cimisy/collections/posts", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ values: { title } }),
          }),
          { params: { route: ["collections", "posts"] } },
        );
      }

      expect((await save(cookieA, "User A First")).status).toBe(200);
      expect((await save(cookieA, "User A Second")).status).toBe(429); // A is exhausted
      expect((await save(cookieB, "User B First")).status).toBe(200); // B has their own budget
    });
  });

  describe("/auth/me", () => {
    it("reports unauthenticated with no session cookie", async () => {
      const res = await handler.GET(req("http://x/api/cimisy/auth/me"), { params: { route: ["auth", "me"] } });
      const body = (await res.json()) as { authenticated: boolean };
      expect(body).toEqual({ authenticated: false });
    });

    it("reports pending (not a 500) for a signed-in user with no assigned role yet", async () => {
      const cookie = await sessionCookieFor("newcomer", "5001");
      const res = await handler.GET(req("http://x/api/cimisy/auth/me", { headers: { cookie } }), {
        params: { route: ["auth", "me"] },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean; role: string | null; pending: boolean; user: { id: string } };
      expect(body.authenticated).toBe(true);
      expect(body.role).toBeNull();
      expect(body.pending).toBe(true);
      expect(body.user.id).toBe("5001");
    });

    it("reports the assigned role and pending: false for a user with a role", async () => {
      seedRoster(fake, [{ githubId: "5002", githubLogin: "assigned", role: "editor" }]);
      const cookie = await sessionCookieFor("assigned", "5002");
      const res = await handler.GET(req("http://x/api/cimisy/auth/me", { headers: { cookie } }), {
        params: { route: ["auth", "me"] },
      });
      const body = (await res.json()) as { authenticated: boolean; role: string | null; pending: boolean; user: { id: string } };
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe("editor");
      expect(body.pending).toBe(false);
      expect(body.user.id).toBe("5002");
    });
  });

  describe("/users (admin-only roster management)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await handler.GET(req("http://x/api/cimisy/users"), { params: { route: ["users"] } });
      expect(res.status).toBe(401);
    });

    it("rejects a non-admin (a pending user, or a role without manageUsers)", async () => {
      seedRoster(fake, [{ githubId: "6001", githubLogin: "editor-user-6", role: "editor" }]);
      const cookie = await sessionCookieFor("editor-user-6", "6001");
      const res = await handler.GET(req("http://x/api/cimisy/users", { headers: { cookie } }), { params: { route: ["users"] } });
      expect(res.status).toBe(403);
    });

    it("lists the roster for an admin", async () => {
      seedRoster(fake, [
        { githubId: "6002", githubLogin: "admin-user-12", role: "admin" },
        { githubId: "6003", githubLogin: "editor-user-7", role: "editor" },
      ]);
      const cookie = await sessionCookieFor("admin-user-12", "6002");
      const res = await handler.GET(req("http://x/api/cimisy/users", { headers: { cookie } }), { params: { route: ["users"] } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: Array<{ githubLogin: string }> };
      expect(body.users.map((u) => u.githubLogin).sort()).toEqual(["admin-user-12", "editor-user-7"]);
    });

    it("rejects a role change from a non-admin", async () => {
      seedRoster(fake, [
        { githubId: "6004", githubLogin: "editor-user-8", role: "editor" },
        { githubId: "6005", githubLogin: "pending-user-1", role: null },
      ]);
      const cookie = await sessionCookieFor("editor-user-8", "6004");
      const res = await handler.POST(
        req("http://x/api/cimisy/users", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ githubId: "6005", role: "publisher" }),
        }),
        { params: { route: ["users"] } },
      );
      expect(res.status).toBe(403);
    });

    it("lets an admin grant a role to a pending user", async () => {
      seedRoster(fake, [
        { githubId: "6006", githubLogin: "admin-user-13", role: "admin" },
        { githubId: "6007", githubLogin: "pending-user-2", role: null },
      ]);
      const cookie = await sessionCookieFor("admin-user-13", "6006");
      const res = await handler.POST(
        req("http://x/api/cimisy/users", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ githubId: "6007", role: "publisher" }),
        }),
        { params: { route: ["users"] } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: Array<{ githubId: string; role: string | null; updatedBy: string }> };
      const updated = body.users.find((u) => u.githubId === "6007");
      expect(updated?.role).toBe("publisher");
      expect(updated?.updatedBy).toBe("admin-user-13");
    });

    it("refuses to leave the roster with zero admins", async () => {
      seedRoster(fake, [{ githubId: "6008", githubLogin: "sole-admin", role: "admin" }]);
      const cookie = await sessionCookieFor("sole-admin", "6008");
      const res = await handler.POST(
        req("http://x/api/cimisy/users", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ githubId: "6008", role: "editor" }),
        }),
        { params: { route: ["users"] } },
      );
      expect(res.status).toBe(400);
    });

    it("allows demoting an admin when another admin remains", async () => {
      seedRoster(fake, [
        { githubId: "6009", githubLogin: "admin-user-14", role: "admin" },
        { githubId: "6010", githubLogin: "admin-user-15", role: "admin" },
      ]);
      const cookie = await sessionCookieFor("admin-user-14", "6009");
      const res = await handler.POST(
        req("http://x/api/cimisy/users", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ githubId: "6010", role: "editor" }),
        }),
        { params: { route: ["users"] } },
      );
      expect(res.status).toBe(200);
    });

    it("404s for an unknown githubId", async () => {
      seedRoster(fake, [{ githubId: "6011", githubLogin: "admin-user-16", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-16", "6011");
      const res = await handler.POST(
        req("http://x/api/cimisy/users", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ githubId: "does-not-exist", role: "editor" }),
        }),
        { params: { route: ["users"] } },
      );
      expect(res.status).toBe(404);
    });

    it("applies CSRF protection to role changes, same as content writes", async () => {
      seedRoster(fake, [{ githubId: "6012", githubLogin: "admin-user-17", role: "admin" }]);
      const cookie = await sessionCookieFor("admin-user-17", "6012");
      const res = await handler.POST(
        req("http://x/api/cimisy/users", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: "https://evil.com" },
          body: JSON.stringify({ githubId: "6012", role: "editor" }),
        }),
        { params: { route: ["users"] } },
      );
      expect(res.status).toBe(403);
    });
  });
});
