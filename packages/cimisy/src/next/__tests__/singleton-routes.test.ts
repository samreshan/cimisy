import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import { collection, config, fields, page, section, singleton } from "../../config/index.js";
import type { ResolvedCimisyConfig, RoleDefinition } from "../../config/define-config.js";
import { createCimisyHandler } from "../route-handler.js";
import { createSessionToken } from "../session.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

const SESSION_SECRET = "test-session-secret-0123456789ab";

/**
 * A full hierarchical config: a top-level collection, a top-level singleton,
 * and a page with a static section + nested collection — exercising the
 * hierarchy end-to-end through the real handler.
 */
function buildConfig(fake: FakeGithubApi, roles?: Record<string, RoleDefinition>): ResolvedCimisyConfig {
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
    roles,
    collections: {
      posts: collection({
        label: "Posts",
        path: "content/posts/*.mdx",
        slugField: "slug",
        schema: {
          title: fields.text({ label: "Title" }),
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
    pages: {
      home: page({
        label: "Home",
        route: "/",
        sections: {
          hero: section({ label: "Hero", schema: { heading: fields.text({ label: "Heading" }) } }),
          testimonials: collection({
            label: "Testimonials",
            slugField: "slug",
            schema: {
              quote: fields.text({ label: "Quote" }),
              slug: fields.slug({ source: "quote" }),
            },
          }),
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

describe("singleton routes (/singletons/*)", () => {
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

  it("GET returns { singleton: null } (200, not 404) for a declared-but-never-saved singleton", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handler.GET(req("http://x/api/cimisy/singletons/settings", { headers: { cookie } }), {
      params: Promise.resolve({ route: ["singletons", "settings"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ singleton: null });
  });

  it("PUT creates and GET reads back; a stale baseVersion then 409s", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");

    const putRes = await handler.PUT(
      req("http://x/api/cimisy/singletons/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { siteName: "Acme" }, baseVersion: null }),
      }),
      { params: Promise.resolve({ route: ["singletons", "settings"] }) },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { version: string; publish: { status: string } };
    expect(putBody.publish.status).toBe("direct");

    const getRes = await handler.GET(req("http://x/api/cimisy/singletons/settings", { headers: { cookie } }), {
      params: Promise.resolve({ route: ["singletons", "settings"] }),
    });
    const getBody = (await getRes.json()) as { singleton: { values: Record<string, unknown>; version: string } };
    expect(getBody.singleton.values).toEqual({ siteName: "Acme" });

    // The file lands as plain YAML at the configured path.
    expect(fake.filesOnBranch("main").get("content/settings.yaml")).toContain("siteName: Acme");
    expect(fake.filesOnBranch("main").get("content/settings.yaml")).not.toContain("---");

    const staleRes = await handler.PUT(
      req("http://x/api/cimisy/singletons/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { siteName: "Stale" }, baseVersion: "not-the-current-version" }),
      }),
      { params: Promise.resolve({ route: ["singletons", "settings"] }) },
    );
    expect(staleRes.status).toBe(409);
  });

  it("an editor's singleton save lands on a draft branch cimisy/<user>/settings/singleton with a PR", async () => {
    seedRoster(fake, [{ githubId: "2", githubLogin: "ed", role: "editor" }]);
    const cookie = await sessionCookieFor("ed", "2");

    const putRes = await handler.PUT(
      req("http://x/api/cimisy/singletons/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { siteName: "Draft name" }, baseVersion: null }),
      }),
      { params: Promise.resolve({ route: ["singletons", "settings"] }) },
    );
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { publish: { status: string; branch?: string } };
    expect(body.publish.status).toBe("draft");
    expect(body.publish.branch).toBe("cimisy/ed/settings/singleton");
    expect(fake.filesOnBranch("cimisy/ed/settings/singleton").get("content/settings.yaml")).toContain("Draft name");
    expect(fake.filesOnBranch("main").get("content/settings.yaml")).toBeUndefined();
  });

  it("page sections are singletons at their derived path, and nested collections CRUD at theirs", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");

    const heroPut = await handler.PUT(
      req("http://x/api/cimisy/singletons/home.hero", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { heading: "Welcome" }, baseVersion: null }),
      }),
      { params: Promise.resolve({ route: ["singletons", "home.hero"] }) },
    );
    expect(heroPut.status).toBe(200);
    expect(fake.filesOnBranch("main").get("content/pages/home/hero.yaml")).toContain("heading: Welcome");

    const entryPost = await handler.POST(
      req("http://x/api/cimisy/collections/home.testimonials", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { quote: "Great Product" }, baseVersion: null }),
      }),
      { params: Promise.resolve({ route: ["collections", "home.testimonials"] }) },
    );
    expect(entryPost.status).toBe(200);
    const entryBody = (await entryPost.json()) as { slug: string };
    expect(entryBody.slug).toBe("great-product");
    expect(fake.filesOnBranch("main").get("content/pages/home/testimonials/great-product.mdx")).toContain("Great Product");
  });

  it("unknown singleton key → 404; malformed key → 404 (never a throw)", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const unknown = await handler.GET(req("http://x/api/cimisy/singletons/nope", { headers: { cookie } }), {
      params: Promise.resolve({ route: ["singletons", "nope"] }),
    });
    expect(unknown.status).toBe(404);
    const malformed = await handler.GET(req("http://x/api/cimisy/singletons/..", { headers: { cookie } }), {
      params: Promise.resolve({ route: ["singletons", ".."] }),
    });
    expect(malformed.status).toBe(404);
  });

  it("RBAC: a role scoped to content/pages/home/** edits home sections but not settings or posts", async () => {
    const scopedRoles: Record<string, RoleDefinition> = {
      "home-editor": {
        directPublish: true,
        rules: [{ path: "content/pages/home/**", actions: ["read", "write", "publish"] }],
      },
    };
    handler = createCimisyHandler(buildConfig(fake, scopedRoles));
    seedRoster(fake, [{ githubId: "3", githubLogin: "scoped", role: "home-editor" }]);
    const cookie = await sessionCookieFor("scoped", "3");

    const heroPut = await handler.PUT(
      req("http://x/api/cimisy/singletons/home.hero", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { heading: "Allowed" }, baseVersion: null }),
      }),
      { params: Promise.resolve({ route: ["singletons", "home.hero"] }) },
    );
    expect(heroPut.status).toBe(200);

    const settingsPut = await handler.PUT(
      req("http://x/api/cimisy/singletons/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ values: { siteName: "Denied" }, baseVersion: null }),
      }),
      { params: Promise.resolve({ route: ["singletons", "settings"] }) },
    );
    expect(settingsPut.status).toBe(403);

    const postsGet = await handler.GET(req("http://x/api/cimisy/collections/posts", { headers: { cookie } }), {
      params: Promise.resolve({ route: ["collections", "posts"] }),
    });
    expect(postsGet.status).toBe(403);
  });
});
