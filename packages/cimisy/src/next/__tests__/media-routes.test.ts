import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import type { ResolvedCimisyConfig } from "../../config/define-config.js";
import { collection, config, fields } from "../../config/index.js";
import { createInMemoryRateLimiter } from "../../security/rate-limit.js";
import { createCimisyHandler } from "../route-handler.js";
import { createSessionToken } from "../session.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

const SESSION_SECRET = "test-session-secret-0123456789ab";
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]).toString("base64");

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
          cover: fields.image({ label: "Cover", directory: "content/uploads" }),
        },
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

describe("media routes (/media, /media/raw)", () => {
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

  async function adminCookie(): Promise<string> {
    seedRoster(fake, [{ githubId: "1", githubLogin: "admin-user", role: "admin" }]);
    return sessionCookieFor("admin-user", "1");
  }

  describe("POST /media (upload)", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(401);
    });

    it("rejects a mismatched-origin request (CSRF)", async () => {
      const cookie = await adminCookie();
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: "http://evil.example" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(403);
    });

    it("an admin uploads a valid PNG and it becomes readable via /media/raw", async () => {
      const cookie = await adminCookie();
      const uploadRes = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "My Photo.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(uploadRes.status).toBe(200);
      const body = (await uploadRes.json()) as { path: string; contentType: string; publish: { status: string } };
      expect(body.path).toMatch(/^content\/uploads\/my-photo-[0-9a-f]{8}\.png$/);
      expect(body.contentType).toBe("image/png");
      expect(body.publish.status).toBe("direct");

      const rawRes = await handler.GET(req(`http://x/api/cimisy/media/raw?path=${encodeURIComponent(body.path)}`, { headers: { cookie } }), {
        params: Promise.resolve({ route: ["media", "raw"] }),
      });
      expect(rawRes.status).toBe(200);
      expect(rawRes.headers.get("content-type")).toBe("image/png");
      expect(rawRes.headers.get("x-content-type-options")).toBe("nosniff");
      const bytes = new Uint8Array(await rawRes.arrayBuffer());
      expect(Buffer.from(bytes).toString("base64")).toBe(PNG_BASE64);
    });

    it("rejects an upload targeting a content key that isn't declared in config with 404", async () => {
      const cookie = await adminCookie();
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            targetKey: "does-not-exist",
            slug: "hello",
            directory: "content/uploads",
            filename: "a.png",
            content: PNG_BASE64,
          }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(404);
    });

    it("an editor's upload lands on their draft branch, not main (same envelope as an entry save)", async () => {
      seedRoster(fake, [
        { githubId: "1", githubLogin: "admin-user", role: "admin" },
        { githubId: "2", githubLogin: "ed-user", role: "editor" },
      ]);
      const cookie = await sessionCookieFor("ed-user", "2");
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string; publish: { status: string; branch?: string } };
      expect(body.publish.status).toBe("draft");
      expect(body.publish.branch).toBe("cimisy/ed-user/posts/hello");
      expect(fake.filesOnBranch(body.publish.branch!).has(body.path)).toBe(true);
      expect(fake.filesOnBranch("main").has(body.path)).toBe(false);
    });

    it("a viewer (read-only) cannot upload (403)", async () => {
      seedRoster(fake, [{ githubId: "3", githubLogin: "view-user", role: "viewer" }]);
      const cookie = await sessionCookieFor("view-user", "3");
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(403);
    });

    it("rejects a directory that isn't a configured image-field directory", async () => {
      const cookie = await adminCookie();
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: ".cimisy", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(400);
    });

    it("rejects a non-image payload (e.g. an SVG) with 400", async () => {
      const cookie = await adminCookie();
      const svgBase64 = Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64");
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.svg", content: svgBase64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(400);
    });

    it("rejects an oversized upload with 400", async () => {
      const cookie = await adminCookie();
      const hugeBase64 = "A".repeat(10 * 1024 * 1024);
      const res = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: hugeBase64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      expect(res.status).toBe(400);
    });

    it("is rate-limited the same way entry writes are", async () => {
      const rateLimiter = createInMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
      const limitedConfig = config({ ...buildConfig(fake), rateLimiter });
      const limitedHandler = createCimisyHandler(limitedConfig);
      const cookie = await adminCookie();
      const uploadReq = () =>
        limitedHandler.POST(
          req("http://x/api/cimisy/media", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
          }),
          { params: Promise.resolve({ route: ["media"] }) },
        );
      const first = await uploadReq();
      expect(first.status).toBe(200);
      const second = await uploadReq();
      expect(second.status).toBe(429);
    });
  });

  describe("GET /media (list)", () => {
    it("lists uploaded files under a configured directory", async () => {
      const cookie = await adminCookie();
      await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      const res = await handler.GET(req("http://x/api/cimisy/media?directory=content/uploads", { headers: { cookie } }), {
        params: Promise.resolve({ route: ["media"] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: Array<{ path: string }> };
      expect(body.files).toHaveLength(1);
      expect(body.files[0]!.path).toMatch(/^content\/uploads\/a-[0-9a-f]{8}\.png$/);
    });

    it("rejects listing a non-configured directory", async () => {
      const cookie = await adminCookie();
      const res = await handler.GET(req("http://x/api/cimisy/media?directory=.cimisy", { headers: { cookie } }), {
        params: Promise.resolve({ route: ["media"] }),
      });
      expect(res.status).toBe(400);
    });

    it("requires the directory query parameter", async () => {
      const cookie = await adminCookie();
      const res = await handler.GET(req("http://x/api/cimisy/media", { headers: { cookie } }), {
        params: Promise.resolve({ route: ["media"] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /media/raw", () => {
    it("blocks reading a path outside every configured image directory (e.g. the RBAC roster file)", async () => {
      const cookie = await adminCookie();
      const res = await handler.GET(req("http://x/api/cimisy/media/raw?path=.cimisy/users.yaml", { headers: { cookie } }), {
        params: Promise.resolve({ route: ["media", "raw"] }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a path that doesn't exist", async () => {
      const cookie = await adminCookie();
      const res = await handler.GET(req("http://x/api/cimisy/media/raw?path=content/uploads/missing.png", { headers: { cookie } }), {
        params: Promise.resolve({ route: ["media", "raw"] }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects an invalid ref (not the default branch or a well-formed draft branch)", async () => {
      const cookie = await adminCookie();
      const res = await handler.GET(
        req("http://x/api/cimisy/media/raw?path=content/uploads/a.png&ref=some-random-branch", { headers: { cookie } }),
        { params: Promise.resolve({ route: ["media", "raw"] }) },
      );
      expect(res.status).toBe(400);
    });

    it("serves an uploaded image from a valid draft-branch ref", async () => {
      seedRoster(fake, [
        { githubId: "1", githubLogin: "admin-user", role: "admin" },
        { githubId: "2", githubLogin: "ed-user", role: "editor" },
      ]);
      const editorCookie = await sessionCookieFor("ed-user", "2");
      const uploadRes = await handler.POST(
        req("http://x/api/cimisy/media", {
          method: "POST",
          headers: { cookie: editorCookie, "content-type": "application/json" },
          body: JSON.stringify({ targetKey: "posts", slug: "hello", directory: "content/uploads", filename: "a.png", content: PNG_BASE64 }),
        }),
        { params: Promise.resolve({ route: ["media"] }) },
      );
      const { path, publish } = (await uploadRes.json()) as { path: string; publish: { branch: string } };

      const rawRes = await handler.GET(
        req(`http://x/api/cimisy/media/raw?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(publish.branch)}`, {
          headers: { cookie: editorCookie },
        }),
        { params: Promise.resolve({ route: ["media", "raw"] }) },
      );
      expect(rawRes.status).toBe(200);
      const bytes = new Uint8Array(await rawRes.arrayBuffer());
      expect(Buffer.from(bytes).toString("base64")).toBe(PNG_BASE64);
    });

    it("rejects unauthenticated requests with 401", async () => {
      const res = await handler.GET(req("http://x/api/cimisy/media/raw?path=content/uploads/a.png"), {
        params: Promise.resolve({ route: ["media", "raw"] }),
      });
      expect(res.status).toBe(401);
    });
  });
});
