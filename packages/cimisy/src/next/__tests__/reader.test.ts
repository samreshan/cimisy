import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import { collection, config, fields } from "../../config/index.js";
import type { CimisyConfig } from "../../config/define-config.js";

const cookiesMock = vi.fn();
const draftModeMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => cookiesMock(),
  draftMode: () => draftModeMock(),
}));

const { createReader } = await import("../reader.js");

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function buildConfig(fake: FakeGithubApi): CimisyConfig {
  return config({
    source: githubSource({
      repo: `${fake.owner}/${fake.repo}`,
      branch: "main",
      appId: "1",
      privateKey,
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "session-secret",
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

describe("createReader — draft-mode-aware reads", () => {
  let fake: FakeGithubApi;

  beforeEach(() => {
    fake = createFakeGithubApi({
      owner: "acme",
      repo: "site",
      initialFiles: { "content/posts/hello.mdx": "---\ntitle: Published Version\nslug: hello\n---\n" },
    });
    fake.install();
  });

  afterEach(() => {
    fake.restore();
    vi.clearAllMocks();
  });

  it("reads from the default branch when draft mode is off", async () => {
    draftModeMock.mockReturnValue({ isEnabled: false });
    const reader = createReader(buildConfig(fake));
    const entry = await reader.collections.posts?.bySlug("hello");
    expect(entry?.values.title).toBe("Published Version");
  });

  it("reads from the preview ref branch when draft mode is on and a matching cookie is set", async () => {
    // Simulate a draft branch that has a DIFFERENT version of the same
    // file, created the same way the admin API's draft workflow would.
    const source = buildConfig(fake).source;
    await source.createBranch?.("cimisy/alice/posts/hello", "main");
    await source.commitChange({
      ref: "cimisy/alice/posts/hello",
      baseVersion: (await source.read("content/posts/hello.mdx", "cimisy/alice/posts/hello"))!.version,
      message: "draft edit",
      author: { id: "1", name: "Alice", email: "alice@example.com" },
      writes: [{ path: "content/posts/hello.mdx", content: "---\ntitle: Draft Version\nslug: hello\n---\n" }],
    });

    draftModeMock.mockReturnValue({ isEnabled: true });
    cookiesMock.mockReturnValue({ get: (name: string) => (name === "cimisy_preview_ref" ? { value: "cimisy/alice/posts/hello" } : undefined) });

    const reader = createReader(buildConfig(fake));
    const entry = await reader.collections.posts?.bySlug("hello");
    expect(entry?.values.title).toBe("Draft Version");

    // The default branch itself must be unaffected by the draft commit.
    draftModeMock.mockReturnValue({ isEnabled: false });
    const published = await reader.collections.posts?.bySlug("hello");
    expect(published?.values.title).toBe("Published Version");
  });

  it("falls back to the default branch when draft mode is on but no preview cookie is set", async () => {
    draftModeMock.mockReturnValue({ isEnabled: true });
    cookiesMock.mockReturnValue({ get: () => undefined });
    const reader = createReader(buildConfig(fake));
    const entry = await reader.collections.posts?.bySlug("hello");
    expect(entry?.values.title).toBe("Published Version");
  });

  it("all() lists every entry on the currently active ref", async () => {
    draftModeMock.mockReturnValue({ isEnabled: false });
    const reader = createReader(buildConfig(fake));
    const entries = await reader.collections.posts?.all();
    expect(entries?.map((e) => e.slug)).toEqual(["hello"]);
  });
});
