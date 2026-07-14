import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { githubSource } from "../../adapters/github/adapter.js";
import { collection, config, fields, page, section, singleton } from "../../config/index.js";
import type { ResolvedCimisyConfig } from "../../config/define-config.js";

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

function buildConfig(fake: FakeGithubApi): ResolvedCimisyConfig {
  return config({
    source: githubSource({
      repo: `${fake.owner}/${fake.repo}`,
      branch: "main",
      appId: "1",
      privateKey,
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "session-secret-0123456789abcdef0",
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

describe("createReader — singletons and pages", () => {
  let fake: FakeGithubApi;

  function buildHierarchicalConfig(): ResolvedCimisyConfig {
    return config({
      source: githubSource({
        repo: `${fake.owner}/${fake.repo}`,
        branch: "main",
        appId: "1",
        privateKey,
        clientId: "client-id",
        clientSecret: "client-secret",
        sessionSecret: "session-secret-0123456789abcdef0",
      }),
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
              schema: { quote: fields.text({ label: "Quote" }), slug: fields.slug({ source: "quote" }) },
            }),
          },
        }),
      },
    });
  }

  beforeEach(() => {
    fake = createFakeGithubApi({
      owner: "acme",
      repo: "site",
      initialFiles: {
        "content/settings.yaml": "siteName: Acme\n",
        "content/pages/home/hero.yaml": "heading: Welcome\n",
        "content/pages/home/testimonials/great.mdx": "---\nquote: Great\nslug: great\n---\n",
      },
    });
    fake.install();
    draftModeMock.mockReturnValue({ isEnabled: false });
  });

  afterEach(() => {
    fake.restore();
    vi.clearAllMocks();
  });

  it("reader.singletons.<key>.get() reads a top-level singleton", async () => {
    const reader = createReader(buildHierarchicalConfig());
    const snapshot = await reader.singletons.settings?.get();
    expect(snapshot?.values).toEqual({ siteName: "Acme" });
    expect(snapshot?.version).toBeTruthy();
  });

  it("get() returns null (not a throw) for a never-saved singleton", async () => {
    fake.restore();
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    const reader = createReader(buildHierarchicalConfig());
    expect(await reader.singletons.settings?.get()).toBeNull();
  });

  it("reader.pages.<page>.<section> exposes section singletons and nested collections by their short key", async () => {
    const reader = createReader(buildHierarchicalConfig());
    const hero = reader.pages.home?.hero as { get(): Promise<{ values: Record<string, unknown> } | null> };
    expect((await hero.get())?.values).toEqual({ heading: "Welcome" });

    const testimonials = reader.pages.home?.testimonials as { all(): Promise<Array<{ slug: string }>> };
    expect((await testimonials.all()).map((e) => e.slug)).toEqual(["great"]);
  });
});
