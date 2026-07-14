import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import type { ResolvedCimisyConfig } from "../../config/define-config.js";
import { collection, config, fields, singleton } from "../../config/index.js";
import { localSource } from "../../storage/local.js";
import { createCimisyHandler } from "../route-handler.js";
import { createSessionToken } from "../session.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

const SESSION_SECRET = "test-session-secret-0123456789ab";

function buildConfig(fake: FakeGithubApi): ResolvedCimisyConfig {
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
    singletons: {
      settings: singleton({
        label: "Site settings",
        path: "content/settings.yaml",
        schema: { siteName: fields.text({ label: "Site name" }) },
      }),
    },
  });
}

async function sessionCookieFor(login: string, userId: string): Promise<string> {
  const token = await createSessionToken({ githubUserId: userId, githubLogin: login, name: login, email: null }, SESSION_SECRET);
  return `cimisy_session=${token}`;
}

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

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  const parsedUrl = new URL(url, "http://localhost:3000");
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (["POST", "PUT", "DELETE"].includes(method) && !headers.has("origin")) {
    headers.set("origin", parsedUrl.origin);
  }
  return new NextRequest(parsedUrl, { ...init, headers });
}

describe("drafts routes (/drafts, /drafts/:id/merge)", () => {
  let fake: FakeGithubApi;
  let handler: ReturnType<typeof createCimisyHandler>;

  beforeEach(() => {
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    handler = createCimisyHandler(buildConfig(fake));
    seedRoster(fake, [
      { githubId: "1", githubLogin: "admin-user", role: "admin" },
      { githubId: "2", githubLogin: "pub-user", role: "publisher" },
      { githubId: "3", githubLogin: "ed-user", role: "editor" },
      { githubId: "4", githubLogin: "ed-user-2", role: "editor" },
    ]);
  });

  afterEach(() => {
    fake.restore();
  });

  describe("GET /drafts", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await handler.GET(req("http://x/api/cimisy/drafts"), { params: Promise.resolve({ route: ["drafts"] }) });
      expect(res.status).toBe(401);
    });

    it("an editor sees only their own drafts, not another editor's", async () => {
      fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      fake.seedPullRequest({ head: "cimisy/ed-user-2/posts/theirs", base: "main", title: "Their draft", authorLogin: "ed-user-2" });
      const cookie = await sessionCookieFor("ed-user", "3");
      const res = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { drafts: Array<{ slug: string; canMerge: boolean }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0]!.slug).toBe("mine");
      expect(body.drafts[0]!.canMerge).toBe(false);
    });

    it("a publisher sees every open draft, with canMerge true", async () => {
      fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      fake.seedPullRequest({ head: "cimisy/ed-user-2/posts/theirs", base: "main", title: "Their draft", authorLogin: "ed-user-2" });
      const cookie = await sessionCookieFor("pub-user", "2");
      const res = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { drafts: Array<{ slug: string; canMerge: boolean }> };
      expect(body.drafts).toHaveLength(2);
      expect(body.drafts.every((d) => d.canMerge)).toBe(true);
    });

    it("lists a singleton draft with kind 'singleton' and its content key (no slug shown)", async () => {
      fake.seedPullRequest({
        head: "cimisy/ed-user/settings/singleton",
        base: "main",
        title: "Settings draft",
        authorLogin: "ed-user",
      });
      const cookie = await sessionCookieFor("pub-user", "2");
      const res = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      const body = (await res.json()) as { drafts: Array<{ kind: string; contentKey: string; slug: string; canMerge: boolean }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0]).toMatchObject({ kind: "singleton", contentKey: "settings", slug: "singleton", canMerge: true });
    });

    it("collection drafts carry kind 'collection' and their content key", async () => {
      fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      const cookie = await sessionCookieFor("pub-user", "2");
      const res = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      const body = (await res.json()) as { drafts: Array<{ kind: string; contentKey: string }> };
      expect(body.drafts[0]).toMatchObject({ kind: "collection", contentKey: "posts" });
    });

    it("ignores PRs whose branch isn't a well-formed cimisy draft branch (fail closed, don't crash)", async () => {
      fake.seedPullRequest({ head: "cimisy/malformed", base: "main", title: "Weird", authorLogin: "someone" });
      fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      const cookie = await sessionCookieFor("pub-user", "2");
      const res = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { drafts: unknown[] };
      expect(body.drafts).toHaveLength(1);
    });

    it("ignores a closed/merged PR", async () => {
      const { number } = fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      await handler.POST(req("http://x/api/cimisy/drafts/" + number + "/merge", { method: "POST", headers: { cookie: await sessionCookieFor("admin-user", "1") } }), {
        params: Promise.resolve({ route: ["drafts", String(number), "merge"] }),
      });
      const cookie = await sessionCookieFor("pub-user", "2");
      const res = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      const body = (await res.json()) as { drafts: unknown[] };
      expect(body.drafts).toHaveLength(0);
    });
  });

  describe("POST /drafts/:id/merge", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await handler.POST(req("http://x/api/cimisy/drafts/1/merge", { method: "POST" }), {
        params: Promise.resolve({ route: ["drafts", "1", "merge"] }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a mismatched-origin request (CSRF)", async () => {
      const cookie = await sessionCookieFor("admin-user", "1");
      const res = await handler.POST(
        req("http://x/api/cimisy/drafts/1/merge", { method: "POST", headers: { cookie, origin: "http://evil.example" } }),
        { params: Promise.resolve({ route: ["drafts", "1", "merge"] }) },
      );
      expect(res.status).toBe(403);
    });

    it("an editor (no publish permission) cannot merge their own draft — write and publish are distinct capabilities", async () => {
      const { number } = fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      const cookie = await sessionCookieFor("ed-user", "3");
      const res = await handler.POST(req(`http://x/api/cimisy/drafts/${number}/merge`, { method: "POST", headers: { cookie } }), {
        params: Promise.resolve({ route: ["drafts", String(number), "merge"] }),
      });
      expect(res.status).toBe(403);
    });

    it("a publisher merges a draft successfully, and it disappears from open PRs afterward", async () => {
      const { number } = fake.seedPullRequest({ head: "cimisy/ed-user/posts/mine", base: "main", title: "My draft", authorLogin: "ed-user" });
      const cookie = await sessionCookieFor("pub-user", "2");
      const res = await handler.POST(req(`http://x/api/cimisy/drafts/${number}/merge`, { method: "POST", headers: { cookie } }), {
        params: Promise.resolve({ route: ["drafts", String(number), "merge"] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      const listRes = await handler.GET(req("http://x/api/cimisy/drafts", { headers: { cookie } }), { params: Promise.resolve({ route: ["drafts"] }) });
      const listBody = (await listRes.json()) as { drafts: unknown[] };
      expect(listBody.drafts).toHaveLength(0);
    });

    it("merging a singleton draft enforces publish on the singleton's own path", async () => {
      const { number } = fake.seedPullRequest({
        head: "cimisy/ed-user/settings/singleton",
        base: "main",
        title: "Settings draft",
        authorLogin: "ed-user",
      });
      // The editor authored it but lacks publish → 403.
      const editorCookie = await sessionCookieFor("ed-user", "3");
      const denied = await handler.POST(req(`http://x/api/cimisy/drafts/${number}/merge`, { method: "POST", headers: { cookie: editorCookie } }), {
        params: Promise.resolve({ route: ["drafts", String(number), "merge"] }),
      });
      expect(denied.status).toBe(403);
      // A publisher can merge it.
      const pubCookie = await sessionCookieFor("pub-user", "2");
      const merged = await handler.POST(req(`http://x/api/cimisy/drafts/${number}/merge`, { method: "POST", headers: { cookie: pubCookie } }), {
        params: Promise.resolve({ route: ["drafts", String(number), "merge"] }),
      });
      expect(merged.status).toBe(200);
    });

    it("returns 404 for an unknown draft id", async () => {
      const cookie = await sessionCookieFor("admin-user", "1");
      const res = await handler.POST(req("http://x/api/cimisy/drafts/99999/merge", { method: "POST", headers: { cookie } }), {
        params: Promise.resolve({ route: ["drafts", "99999", "merge"] }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("local adapter (no pull-request support)", () => {
    it("GET /drafts returns an empty list rather than erroring", async () => {
      const localConfig = config({
        source: localSource({ rootDir: "/tmp/cimisy-drafts-test", allowInProduction: true }),
        collections: buildConfig(fake).collections,
      });
      const localHandler = createCimisyHandler(localConfig);
      const res = await localHandler.GET(req("http://x/api/cimisy/drafts"), { params: Promise.resolve({ route: ["drafts"] }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { drafts: unknown[] };
      expect(body.drafts).toEqual([]);
    });

    it("POST /drafts/:id/merge returns 404 rather than erroring", async () => {
      const localConfig = config({
        source: localSource({ rootDir: "/tmp/cimisy-drafts-test", allowInProduction: true }),
        collections: buildConfig(fake).collections,
      });
      const localHandler = createCimisyHandler(localConfig);
      const res = await localHandler.POST(req("http://x/api/cimisy/drafts/1/merge", { method: "POST" }), {
        params: Promise.resolve({ route: ["drafts", "1", "merge"] }),
      });
      expect(res.status).toBe(404);
    });
  });
});
