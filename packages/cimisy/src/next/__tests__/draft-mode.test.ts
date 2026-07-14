import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import type { ResolvedCimisyConfig } from "../../config/define-config.js";
import { collection, config, fields } from "../../config/index.js";
import { createSessionToken } from "../session.js";

const draftModeEnableMock = vi.fn();
const draftModeDisableMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined }),
  draftMode: () => ({ isEnabled: false, enable: draftModeEnableMock, disable: draftModeDisableMock }),
}));

const { handlePreviewDisable, handlePreviewEnable, PREVIEW_REF_COOKIE_NAME } = await import("../draft-mode.js");

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
          title: fields.text({ label: "Title" }),
          slug: fields.slug({ source: "title" }),
        },
      }),
    },
  });
}

async function sessionCookieFor(login: string, userId: string): Promise<string> {
  const token = await createSessionToken({ githubUserId: userId, githubLogin: login, name: login, email: null }, SESSION_SECRET);
  return `cimisy_session=${token}`;
}

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

/** Seeds .cimisy/users.yaml directly — role resolution now goes through the roster, not live collaborator permission (see rbac/resolve-role.ts). */
function seedRoster(fake: FakeGithubApi, records: Array<{ githubId: string; githubLogin: string; role: string }>): void {
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

describe("handlePreviewEnable", () => {
  let fake: FakeGithubApi;
  let cimisyConfig: ResolvedCimisyConfig;

  beforeEach(() => {
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    cimisyConfig = buildConfig(fake);
  });

  afterEach(() => {
    fake.restore();
    vi.clearAllMocks();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await handlePreviewEnable(req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello"), cimisyConfig);
    expect(res.status).toBe(401);
  });

  it("requires collection and slug query params", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(req("http://x/api/cimisy/preview/enable", { headers: { cookie } }), cimisyConfig);
    expect(res.status).toBe(400);
  });

  it("rejects a collaborator without read permission on the target path (403)", async () => {
    const configWithRestrictedRoles = config({
      ...cimisyConfig,
      roles: { blocked: { directPublish: false, rules: [] } },
    });
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "blocked" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(
      req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello", { headers: { cookie } }),
      configWithRestrictedRoles,
    );
    expect(res.status).toBe(403);
  });

  it("enables draft mode and sets the preview-ref cookie to the default branch for a direct-publish role", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]); // admin (directPublish: true)
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(
      req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello&redirectTo=/blog/hello", { headers: { cookie } }),
      cimisyConfig,
    );
    expect(draftModeEnableMock).toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://x/blog/hello");
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${PREVIEW_REF_COOKIE_NAME}=main`);
  });

  it("enables draft mode and sets the preview-ref cookie to the draft branch for a non-direct-publish role", async () => {
    seedRoster(fake, [{ githubId: "2", githubLogin: "bob", role: "editor" }]); // editor (directPublish: false)
    const cookie = await sessionCookieFor("bob", "2");
    const res = await handlePreviewEnable(
      req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello", { headers: { cookie } }),
      cimisyConfig,
    );
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${PREVIEW_REF_COOKIE_NAME}=cimisy%2Fbob%2Fposts%2Fhello`);
  });

  it("accepts a valid ?ref= for a draft branch belonging to someone else (reviewing their draft)", async () => {
    seedRoster(fake, [
      { githubId: "1", githubLogin: "alice", role: "publisher" }, // publish permission, reviewing bob's draft
      { githubId: "2", githubLogin: "bob", role: "editor" },
    ]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(
      req(
        "http://x/api/cimisy/preview/enable?collection=posts&slug=hello&ref=" + encodeURIComponent("cimisy/bob/posts/hello"),
        { headers: { cookie } },
      ),
      cimisyConfig,
    );
    expect(res.status).toBe(307);
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${PREVIEW_REF_COOKIE_NAME}=cimisy%2Fbob%2Fposts%2Fhello`);
  });

  it("rejects a ?ref= that isn't a well-formed draft branch", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(
      req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello&ref=some-random-branch", { headers: { cookie } }),
      cimisyConfig,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a ?ref= whose parsed collection/slug doesn't match the requested collection/slug (can't preview an unrelated entry under someone else's draft ref)", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(
      req(
        "http://x/api/cimisy/preview/enable?collection=posts&slug=hello&ref=" +
          encodeURIComponent("cimisy/bob/posts/different-slug"),
        { headers: { cookie } },
      ),
      cimisyConfig,
    );
    expect(res.status).toBe(400);
  });

  it("still enforces read permission even with a valid ?ref=", async () => {
    const configWithRestrictedRoles = config({
      ...cimisyConfig,
      roles: { blocked: { directPublish: false, rules: [] } },
    });
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "blocked" }]);
    const cookie = await sessionCookieFor("alice", "1");
    const res = await handlePreviewEnable(
      req(
        "http://x/api/cimisy/preview/enable?collection=posts&slug=hello&ref=" + encodeURIComponent("cimisy/bob/posts/hello"),
        { headers: { cookie } },
      ),
      configWithRestrictedRoles,
    );
    expect(res.status).toBe(403);
  });

  it("rejects an absolute/protocol-relative redirectTo (open-redirect prevention)", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const cookie = await sessionCookieFor("alice", "1");

    const evilTargets = ["https://evil.com/phish", "//evil.com/phish", "http://evil.com"];
    for (const evil of evilTargets) {
      const res = await handlePreviewEnable(
        req(`http://x/api/cimisy/preview/enable?collection=posts&slug=hello&redirectTo=${encodeURIComponent(evil)}`, {
          headers: { cookie },
        }),
        cimisyConfig,
      );
      expect(res.headers.get("location")).toBe("http://x/");
    }
  });
});

describe("handlePreviewDisable", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("disables draft mode and clears the preview-ref cookie", async () => {
    const res = await handlePreviewDisable(req("http://x/api/cimisy/preview/disable?redirectTo=/blog"));
    expect(draftModeDisableMock).toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://x/blog");
  });

  it("rejects an absolute redirectTo here too", async () => {
    const res = await handlePreviewDisable(req("http://x/api/cimisy/preview/disable?redirectTo=https://evil.com"));
    expect(res.headers.get("location")).toBe("http://x/");
  });
});
