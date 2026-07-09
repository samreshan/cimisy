import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import type { CimisyConfig } from "../../config/define-config.js";
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

describe("handlePreviewEnable", () => {
  let fake: FakeGithubApi;
  let cimisyConfig: CimisyConfig;

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
    const cookie = await sessionCookieFor("alice", "1");
    fake.setCollaboratorPermission("alice", "admin");
    const res = await handlePreviewEnable(req("http://x/api/cimisy/preview/enable", { headers: { cookie } }), cimisyConfig);
    expect(res.status).toBe(400);
  });

  it("rejects a collaborator without read permission on the target path (403)", async () => {
    const configWithRestrictedRoles = config({
      ...cimisyConfig,
      roles: { blocked: { directPublish: false, rules: [] } },
      roleMapping: { admin: "blocked" },
    });
    const cookie = await sessionCookieFor("alice", "1");
    fake.setCollaboratorPermission("alice", "admin");
    const res = await handlePreviewEnable(
      req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello", { headers: { cookie } }),
      configWithRestrictedRoles,
    );
    expect(res.status).toBe(403);
  });

  it("enables draft mode and sets the preview-ref cookie to the default branch for a direct-publish role", async () => {
    const cookie = await sessionCookieFor("alice", "1");
    fake.setCollaboratorPermission("alice", "admin"); // maps to "admin" (directPublish: true) via default role mapping
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
    const cookie = await sessionCookieFor("bob", "2");
    fake.setCollaboratorPermission("bob", "write"); // maps to "editor" (directPublish: false)
    const res = await handlePreviewEnable(
      req("http://x/api/cimisy/preview/enable?collection=posts&slug=hello", { headers: { cookie } }),
      cimisyConfig,
    );
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${PREVIEW_REF_COOKIE_NAME}=cimisy%2Fbob%2Fposts%2Fhello`);
  });

  it("rejects an absolute/protocol-relative redirectTo (open-redirect prevention)", async () => {
    const cookie = await sessionCookieFor("alice", "1");
    fake.setCollaboratorPermission("alice", "admin");

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
