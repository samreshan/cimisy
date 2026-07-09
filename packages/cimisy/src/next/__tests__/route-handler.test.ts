import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("rejects a GitHub-authenticated user who isn't a repo collaborator (403)", async () => {
    const cookie = await sessionCookieFor("outsider", "1001");
    const res = await handler.GET(req("http://x/api/cimisy/collections/posts", { headers: { cookie } }), {
      params: { route: ["collections", "posts"] },
    });
    expect(res.status).toBe(403);
  });

  it("an admin-permission collaborator reads and publishes directly", async () => {
    fake.setCollaboratorPermission("admin-user-1", "admin");
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

  it("a write-permission collaborator (editor) drafts via a branch + PR instead of publishing directly", async () => {
    fake.setCollaboratorPermission("editor-user-1", "write");
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

  it("a read-only collaborator (viewer) cannot write, even to their own draft branch (403)", async () => {
    fake.setCollaboratorPermission("viewer-user-1", "read");
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
    fake.setCollaboratorPermission("viewer-user-2", "read");
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
    fake.setCollaboratorPermission("editor-user-2", "write");
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
    fake.setCollaboratorPermission("admin-user-2", "admin");
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

    fake.setCollaboratorPermission("viewer-user-3", "read");
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
      fake.setCollaboratorPermission("admin-user-7", "admin");
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
      fake.setCollaboratorPermission("viewer-user-4", "read");
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
      fake.setCollaboratorPermission("admin-user-8", "admin");
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
      fake.setCollaboratorPermission("admin-user-3", "admin");
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
      fake.setCollaboratorPermission("admin-user-4", "admin");
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
      fake.setCollaboratorPermission("admin-user-5", "admin");
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
      fake.setCollaboratorPermission("admin-user-6", "admin");
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

      fake.setCollaboratorPermission("admin-user-9", "admin");
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

      fake.setCollaboratorPermission("admin-user-10", "admin");
      fake.setCollaboratorPermission("admin-user-11", "admin");
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
});
